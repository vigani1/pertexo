import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import { inRetentionTransaction } from './retention-transaction.js';

export interface RunArtifactRetentionStore {
  delete(input: {
    readonly artifactId: string;
    readonly signal?: AbortSignal;
    readonly workspaceId: string;
  }): Promise<void>;
  head(input: {
    readonly artifactId: string;
    readonly signal?: AbortSignal;
    readonly workspaceId: string;
  }): Promise<object | null>;
}

export type RunArtifactRetentionProcessResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      artifactId: string;
      status: 'completed' | 'referenced' | 'waiting';
      workspaceId: string;
    }>;

export interface RunArtifactRetentionCoordinator {
  close(): Promise<void>;
  processNext(signal?: AbortSignal): Promise<RunArtifactRetentionProcessResult>;
}

export interface RunArtifactRetentionCoordinatorOptions {
  readonly externalOperationTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

const optionsSchema = z
  .object({
    externalOperationTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
    lockTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
    statementTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
  })
  .strict();

const candidateSchema = z.object({ id: z.uuid(), workspace_id: z.uuid() });

/**
 * An expired upload or artifact is due unless something still refers to it.
 * A `deleting` artifact waits for its retry time, which also keeps a second
 * worker away while the first erases its bytes.
 */
const DUE_ARTIFACT = `
  select artifact.id, artifact.workspace_id
  from app.artifacts artifact
  where ((artifact.status = 'pending' and artifact.purpose = 'user-upload'
          and artifact.expires_at <= clock_timestamp())
      or (artifact.status = 'available' and artifact.expires_at <= clock_timestamp())
      or artifact.status = 'deleting')
    and (artifact.retention_retry_at is null
      or artifact.retention_retry_at <= clock_timestamp())
    and not exists (select 1 from app.artifact_links link
      where link.workspace_id = artifact.workspace_id and link.artifact_id = artifact.id)
  order by artifact.expires_at, artifact.id
  limit 1 for update skip locked`;

/** Run inputs, outputs, events and checkpoints that still name the artifact. */
const REFERENCED = `
  select exists (select 1 from app.workflow_runs run
      where run.workspace_id = $1
        and (app.jsonb_references_artifact(run.input_ref, $2)
          or app.jsonb_references_artifact(run.output_ref, $2)))
    or exists (select 1 from app.node_runs node
      where node.workspace_id = $1
        and (app.jsonb_references_artifact(node.input_ref, $2)
          or app.jsonb_references_artifact(node.output_ref, $2)))
    or exists (select 1 from app.node_attempts attempt
      where attempt.workspace_id = $1
        and (app.jsonb_references_artifact(attempt.output_ref, $2)
          or app.jsonb_references_artifact(attempt.reconciliation_ref, $2)))
    or exists (select 1 from app.run_events event
      where event.workspace_id = $1
        and app.jsonb_references_artifact(event.payload, $2))
    or exists (select 1 from app.run_checkpoints checkpoint
      where checkpoint.workspace_id = $1
        and app.jsonb_references_artifact(checkpoint.scheduler_state, $2))
    referenced`;

async function retryLater(
  client: PoolClient,
  artifactId: string,
  delay: string,
): Promise<void> {
  await client.query(
    `update app.artifacts
     set retention_retry_at = clock_timestamp() + $2::interval,
         updated_at = clock_timestamp()
     where id = $1`,
    [artifactId, delay],
  );
}

/**
 * Deletes expired run artifacts and abandoned uploads: the artifact is marked
 * deleting, its bytes are erased outside any transaction, and its row goes
 * once the store no longer has them.
 */
export function createRunArtifactRetentionCoordinator(
  config: DatabaseConfig,
  artifacts: RunArtifactRetentionStore,
  inputOptions: RunArtifactRetentionCoordinatorOptions = {},
  runtime?: DatabaseRuntime,
): RunArtifactRetentionCoordinator {
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;
  const transaction = <T>(
    signal: AbortSignal | undefined,
    workspaceId: string | undefined,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> =>
    inRetentionTransaction(pool, options, signal, async (client) => {
      // Artifact capacity is charged in the artifact's own workspace.
      if (workspaceId !== undefined)
        await client.query("select set_config('app.workspace_id', $1, true)", [
          workspaceId,
        ]);
      return work(client);
    });

  return Object.freeze({
    close: () => lease.close(),
    processNext: async (
      signal?: AbortSignal,
    ): Promise<RunArtifactRetentionProcessResult> => {
      const prepared = await transaction(signal, undefined, async (client) => {
        const due = await client.query(DUE_ARTIFACT);
        if (due.rows[0] === undefined) return undefined;
        const artifact = candidateSchema.parse(due.rows[0]);
        await client.query("select set_config('app.workspace_id', $1, true)", [
          artifact.workspace_id,
        ]);
        const referenced = await client.query<{ referenced: boolean }>(
          REFERENCED,
          [artifact.workspace_id, artifact.id],
        );
        if (referenced.rows[0]?.referenced === true) {
          await retryLater(client, artifact.id, '1 day');
          return { ...artifact, referenced: true };
        }
        await client.query(
          `update app.artifacts
           set status = 'deleting', retention_retry_at = clock_timestamp() + interval '1 minute',
               updated_at = clock_timestamp()
           where id = $1`,
          [artifact.id],
        );
        return { ...artifact, referenced: false };
      });
      if (prepared === undefined) return Object.freeze({ status: 'idle' });
      const artifactId = prepared.id;
      const workspaceId = prepared.workspace_id;
      if (prepared.referenced)
        return Object.freeze({ artifactId, status: 'referenced', workspaceId });

      const external = AbortSignal.any([
        ...(signal === undefined ? [] : [signal]),
        AbortSignal.timeout(options.externalOperationTimeoutMs),
      ]);
      await artifacts.delete({ artifactId, signal: external, workspaceId });
      if (
        (await artifacts.head({
          artifactId,
          signal: external,
          workspaceId,
        })) !== null
      )
        // The store still has the bytes; the retry time brings it back.
        return Object.freeze({ artifactId, status: 'waiting', workspaceId });

      await transaction(signal, workspaceId, (client) =>
        client.query(
          `delete from app.artifacts where id = $1 and status = 'deleting'`,
          [artifactId],
        ),
      );
      return Object.freeze({ artifactId, status: 'completed', workspaceId });
    },
  });
}
