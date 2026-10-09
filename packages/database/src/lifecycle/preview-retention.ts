import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import { acquireDatabasePool } from '../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../platform/pool/runtime.js';
import { inRetentionTransaction } from './retention-transaction.js';

export interface PreviewRetentionArtifactStore {
  delete(
    input: Readonly<{
      artifactId: string;
      signal?: AbortSignal;
      workspaceId: string;
    }>,
  ): Promise<void>;
  head(
    input: Readonly<{
      artifactId: string;
      signal?: AbortSignal;
      workspaceId: string;
    }>,
  ): Promise<object | null>;
}

export type PreviewRetentionProcessResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      artifactId?: string;
      previewRunId: string;
      status: 'completed' | 'progressed' | 'waiting';
      workspaceId: string;
    }>;

export interface PreviewRetentionCoordinator {
  close(): Promise<void>;
  processNext(signal?: AbortSignal): Promise<PreviewRetentionProcessResult>;
}

export interface PreviewRetentionCoordinatorOptions {
  readonly artifactQuiescenceSeconds?: number;
  readonly externalOperationTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

const optionsSchema = z
  .object({
    artifactQuiescenceSeconds: z.number().int().min(1).max(120).default(60),
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

const previewSchema = z.object({ id: z.uuid(), workspace_id: z.uuid() });
const artifactSchema = z.object({
  id: z.uuid(),
  status: z.enum(['pending', 'available', 'deleting']),
  quiet: z.boolean(),
});

/** A finished preview past its expiry that no later preview builds on. */
const DUE_PREVIEW = `
  select preview.id, preview.workspace_id
  from app.preview_runs preview
  where preview.expires_at <= clock_timestamp()
    and preview.status in ('succeeded', 'failed', 'canceled', 'timed_out', 'outcome_unknown')
    and not exists (select 1 from app.preview_runs child
      where child.workspace_id = preview.workspace_id
        and child.prior_preview_run_id = preview.id)
  order by preview.expires_at, preview.id
  limit 1 for update skip locked`;

/** Deletes a preview whose artifacts are all gone, with its attempts. */
async function removePreview(
  client: PoolClient,
  workspaceId: string,
  previewRunId: string,
): Promise<void> {
  await client.query(
    `with links as (
       delete from app.artifact_links
       where workspace_id = $1 and owner_kind = 'preview_run' and owner_id = $2
       returning artifact_id
     )
     delete from app.artifacts artifact using links
     where artifact.workspace_id = $1 and artifact.id = links.artifact_id
       and artifact.status = 'deleted'`,
    [workspaceId, previewRunId],
  );
  await client.query(
    'delete from app.preview_attempts where workspace_id = $1 and preview_run_id = $2',
    [workspaceId, previewRunId],
  );
  await client.query(
    `delete from app.idempotency_records
     where workspace_id = $1 and operation = 'preview.execute'
       and resource_id = $2 and expires_at <= clock_timestamp()`,
    [workspaceId, previewRunId],
  );
  await client.query(
    'delete from app.preview_runs where workspace_id = $1 and id = $2',
    [workspaceId, previewRunId],
  );
}

/**
 * Deletes expired previews. A preview's artifacts are marked deleting, left
 * alone long enough for in-flight uploads to time out, erased outside any
 * transaction, and marked deleted; the preview goes once none remain.
 */
export function createPreviewRetentionCoordinator(
  config: DatabaseConfig,
  artifacts: PreviewRetentionArtifactStore,
  inputOptions: PreviewRetentionCoordinatorOptions = {},
  runtime?: DatabaseRuntime,
): PreviewRetentionCoordinator {
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;
  const transaction = <T>(
    signal: AbortSignal | undefined,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> => inRetentionTransaction(pool, options, signal, work);
  const inWorkspace = async (client: PoolClient, workspaceId: string) => {
    // Artifact capacity is charged in the artifact's own workspace.
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
  };

  return Object.freeze({
    close: () => lease.close(),
    processNext: async (
      signal?: AbortSignal,
    ): Promise<PreviewRetentionProcessResult> => {
      const step = await transaction(signal, async (client) => {
        const due = await client.query(DUE_PREVIEW);
        if (due.rows[0] === undefined) return undefined;
        const preview = previewSchema.parse(due.rows[0]);
        const result = {
          previewRunId: preview.id,
          workspaceId: preview.workspace_id,
        };
        await inWorkspace(client, preview.workspace_id);
        const linked = await client.query(
          `select artifact.id, artifact.status,
             artifact.updated_at <= clock_timestamp() - make_interval(secs => $3) quiet
           from app.artifact_links link
           join app.artifacts artifact
             on artifact.workspace_id = link.workspace_id and artifact.id = link.artifact_id
           where link.workspace_id = $1 and link.owner_kind = 'preview_run'
             and link.owner_id = $2 and artifact.status <> 'deleted'
           order by artifact.id limit 1 for update of artifact`,
          [preview.workspace_id, preview.id, options.artifactQuiescenceSeconds],
        );
        if (linked.rows[0] === undefined) {
          await removePreview(client, preview.workspace_id, preview.id);
          return { ...result, status: 'completed' as const };
        }
        const artifact = artifactSchema.parse(linked.rows[0]);
        if (artifact.status !== 'deleting') {
          await client.query(
            `update app.artifacts set status = 'deleting', updated_at = clock_timestamp()
             where id = $1`,
            [artifact.id],
          );
          return {
            ...result,
            artifactId: artifact.id,
            status: 'waiting' as const,
          };
        }
        // Uploads still in flight must time out before their bytes go.
        if (!artifact.quiet)
          return {
            ...result,
            artifactId: artifact.id,
            status: 'waiting' as const,
          };
        return { ...result, artifactId: artifact.id, status: 'erase' as const };
      });
      if (step === undefined) return Object.freeze({ status: 'idle' });
      if (step.status !== 'erase') return Object.freeze(step);

      const { artifactId, previewRunId, workspaceId } = step;
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
        return Object.freeze({ ...step, status: 'waiting' });
      const finished = await transaction(signal, async (client) => {
        await inWorkspace(client, workspaceId);
        await client.query(
          `update app.artifacts
           set status = 'deleted', deleted_at = clock_timestamp(), updated_at = clock_timestamp()
           where id = $1 and status = 'deleting'`,
          [artifactId],
        );
        const remaining = await client.query(
          `select 1 from app.artifact_links link
           join app.artifacts artifact
             on artifact.workspace_id = link.workspace_id and artifact.id = link.artifact_id
           where link.workspace_id = $1 and link.owner_kind = 'preview_run'
             and link.owner_id = $2 and artifact.status <> 'deleted'
           limit 1`,
          [workspaceId, previewRunId],
        );
        if (remaining.rowCount !== 0) return false;
        await removePreview(client, workspaceId, previewRunId);
        return true;
      });
      return Object.freeze({
        artifactId,
        previewRunId,
        status: finished ? 'completed' : 'progressed',
        workspaceId,
      });
    },
  });
}
