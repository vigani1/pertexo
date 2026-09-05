import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import type { Pool } from 'pg';
import type { PoolClient, QueryResult } from 'pg';
import { z } from 'zod';
import { sha256HexSchema } from '../validation/persisted-primitives.js';

import type { DatabaseConfig } from '../config.js';
import type { ControlLedger } from './control-ledger-coordinator.js';
import { inRetentionTransaction } from './retention-transaction.js';

const uuidSchema = z.uuid();

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
      status:
        | 'blocked'
        | 'completed'
        | 'held'
        | 'progressed'
        | 'released'
        | 'waiting';
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

function query<Row extends Record<string, unknown>>(
  client: Pool | PoolClient,
  text: string,
  values: readonly unknown[],
  signal?: AbortSignal,
): Promise<QueryResult<Row>> {
  signal?.throwIfAborted();
  return client.query<Row>({
    text,
    values: [...values],
    ...(signal === undefined ? {} : { signal }),
  });
}

function exactLedgerProjection(
  reconciliation: Awaited<ReturnType<ControlLedger['reconcile']>>,
  sequence: number,
  hash: string,
): boolean {
  return (
    reconciliation.reachedHighWater &&
    !reconciliation.hasMore &&
    reconciliation.records.length === 0 &&
    reconciliation.pageEndSequence === sequence &&
    reconciliation.pageEndHash === hash
  );
}

export function createPreviewRetentionCoordinator(
  config: DatabaseConfig,
  ledger: ControlLedger,
  artifacts: PreviewRetentionArtifactStore,
  inputOptions: PreviewRetentionCoordinatorOptions = {},
  runtime?: DatabaseRuntime,
): PreviewRetentionCoordinator {
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;

  return Object.freeze({
    close: () => lease.close(),
    processNext: async (signal?: AbortSignal) => {
      const due = await query<{ preview_run_id: string; workspace_id: string }>(
        pool,
        'select * from app.find_due_preview_cleanup(1)',
        [],
        signal,
      );
      const candidate = due.rows[0];
      if (candidate === undefined)
        return Object.freeze({ status: 'idle' as const });
      const workspaceId = uuidSchema.parse(candidate.workspace_id);
      const previewRunId = uuidSchema.parse(candidate.preview_run_id);
      const transactionOptions = {
        lockTimeoutMs: options.lockTimeoutMs,
        statementTimeoutMs: options.statementTimeoutMs,
      };
      const highWater = await inRetentionTransaction(
        pool,
        transactionOptions,
        signal,
        async (client) => {
          const locked = await query<{
            retention_control_hash: string;
            retention_control_sequence: string | number;
          }>(
            client,
            'select * from app.lock_workspace_control_ledger($1)',
            [workspaceId],
            signal,
          );
          const row = locked.rows[0];
          if (row === undefined)
            throw new Error('Preview workspace control lock was not returned');
          return Object.freeze({
            hash: sha256HexSchema.parse(row.retention_control_hash),
            sequence: z.coerce
              .number()
              .int()
              .nonnegative()
              .parse(row.retention_control_sequence),
          });
        },
      );
      const timeoutSignal = AbortSignal.timeout(
        options.externalOperationTimeoutMs,
      );
      const externalSignal =
        signal === undefined
          ? timeoutSignal
          : AbortSignal.any([signal, timeoutSignal]);
      const reconciliation = await ledger.reconcile({
        maxRecords: 1,
        projectedHash: highWater.hash,
        projectedSequence: highWater.sequence,
        signal: externalSignal,
        workspaceId,
      });
      if (
        !exactLedgerProjection(
          reconciliation,
          highWater.sequence,
          highWater.hash,
        )
      )
        return Object.freeze({
          previewRunId,
          status: 'released' as const,
          workspaceId,
        });
      const step = await inRetentionTransaction(
        pool,
        transactionOptions,
        signal,
        async (client) => {
          const prepared = await query<{
            artifact_id: string | null;
            outcome: string;
          }>(
            client,
            'select * from app.prepare_preview_cleanup_step($1,$2,$3,$4,$5)',
            [
              workspaceId,
              previewRunId,
              options.artifactQuiescenceSeconds,
              highWater.sequence,
              highWater.hash,
            ],
            signal,
          );
          const row = prepared.rows[0];
          if (row === undefined)
            throw new Error('Preview cleanup step was not returned');
          return Object.freeze({
            artifactId: row.artifact_id,
            outcome: z
              .enum([
                'artifact',
                'blocked',
                'completed',
                'finish',
                'held',
                'waiting',
              ])
              .parse(row.outcome),
          });
        },
      );
      if (step.outcome === 'artifact') {
        const artifactId = uuidSchema.parse(step.artifactId);
        await artifacts.delete({
          artifactId,
          signal: externalSignal,
          workspaceId,
        });
        const remaining = await artifacts.head({
          artifactId,
          signal: externalSignal,
          workspaceId,
        });
        if (remaining === null) {
          const completed = await inRetentionTransaction(
            pool,
            transactionOptions,
            signal,
            async (client) => {
              const completed = await query<{ completed: boolean }>(
                client,
                'select app.complete_preview_artifact_cleanup($1,$2,$3,$4) completed',
                [workspaceId, artifactId, highWater.sequence, highWater.hash],
                signal,
              );
              if (completed.rows[0]?.completed !== true)
                throw new Error('Preview artifact cleanup completion was lost');
              const finished = await query<{ completed: boolean }>(
                client,
                'select app.finish_preview_cleanup($1,$2,$3,$4) completed',
                [workspaceId, previewRunId, highWater.sequence, highWater.hash],
                signal,
              );
              return finished.rows[0]?.completed === true;
            },
          );
          return Object.freeze({
            artifactId,
            previewRunId,
            status: completed
              ? ('completed' as const)
              : ('progressed' as const),
            workspaceId,
          });
        }
        return Object.freeze({
          artifactId,
          previewRunId,
          status: 'waiting' as const,
          workspaceId,
        });
      }
      if (step.outcome === 'finish' || step.outcome === 'completed') {
        const finished = await inRetentionTransaction(
          pool,
          transactionOptions,
          signal,
          async (client) => {
            const finished = await query<{ completed: boolean }>(
              client,
              'select app.finish_preview_cleanup($1,$2,$3,$4) completed',
              [workspaceId, previewRunId, highWater.sequence, highWater.hash],
              signal,
            );
            return finished.rows[0]?.completed === true;
          },
        );
        return Object.freeze({
          previewRunId,
          status: finished ? ('completed' as const) : ('blocked' as const),
          workspaceId,
        });
      }
      return Object.freeze({
        previewRunId,
        status: step.outcome,
        workspaceId,
      });
    },
  });
}
