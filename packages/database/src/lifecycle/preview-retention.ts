import { createDatabasePool } from '../postgres-telemetry.js';
import type { Pool } from 'pg';
import type { PoolClient, QueryResult } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import type { ControlLedger } from './control-ledger-coordinator.js';

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
): PreviewRetentionCoordinator {
  const options = optionsSchema.parse(inputOptions);
  const pool = createDatabasePool({
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    max: config.max,
  });

  return Object.freeze({
    close: () => pool.end(),
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
      const client = await pool.connect();
      let transactionComplete = false;
      let destroyClient = false;
      try {
        await query(client, 'begin', [], signal);
        await query(
          client,
          `set local lock_timeout='${String(options.lockTimeoutMs)}ms';
           set local statement_timeout='${String(options.statementTimeoutMs)}ms';
           set local idle_in_transaction_session_timeout='0'`,
          [],
          signal,
        );
        const locked = await query<{
          retention_control_hash: string;
          retention_control_sequence: string | number;
        }>(
          client,
          'select * from app.lock_workspace_control_ledger($1)',
          [workspaceId],
          signal,
        );
        const highWater = locked.rows[0];
        if (highWater === undefined)
          throw new Error('Preview workspace control lock was not returned');
        const sequence = z.coerce
          .number()
          .int()
          .nonnegative()
          .parse(highWater.retention_control_sequence);
        const hash = z
          .string()
          .regex(/^[0-9a-f]{64}$/u)
          .parse(highWater.retention_control_hash);
        const timeoutSignal = AbortSignal.timeout(
          options.externalOperationTimeoutMs,
        );
        const externalSignal =
          signal === undefined
            ? timeoutSignal
            : AbortSignal.any([signal, timeoutSignal]);
        const reconciliation = await ledger.reconcile({
          maxRecords: 1,
          projectedHash: hash,
          projectedSequence: sequence,
          signal: externalSignal,
          workspaceId,
        });
        if (!exactLedgerProjection(reconciliation, sequence, hash)) {
          await query(client, 'rollback', [], signal);
          transactionComplete = true;
          return Object.freeze({
            previewRunId,
            status: 'released' as const,
            workspaceId,
          });
        }
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
            sequence,
            hash,
          ],
          signal,
        );
        const step = prepared.rows[0];
        if (step === undefined)
          throw new Error('Preview cleanup step was not returned');
        const outcome = z
          .enum([
            'artifact',
            'blocked',
            'completed',
            'finish',
            'held',
            'waiting',
          ])
          .parse(step.outcome);
        let result: PreviewRetentionProcessResult;
        if (outcome === 'artifact') {
          const artifactId = uuidSchema.parse(step.artifact_id);
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
            const completed = await query<{ completed: boolean }>(
              client,
              'select app.complete_preview_artifact_cleanup($1,$2,$3,$4) completed',
              [workspaceId, artifactId, sequence, hash],
              signal,
            );
            if (completed.rows[0]?.completed !== true)
              throw new Error('Preview artifact cleanup completion was lost');
            const finished = await query<{ completed: boolean }>(
              client,
              'select app.finish_preview_cleanup($1,$2,$3,$4) completed',
              [workspaceId, previewRunId, sequence, hash],
              signal,
            );
            result = Object.freeze({
              artifactId,
              previewRunId,
              status:
                finished.rows[0]?.completed === true
                  ? 'completed'
                  : 'progressed',
              workspaceId,
            });
          } else {
            result = Object.freeze({
              artifactId,
              previewRunId,
              status: 'waiting',
              workspaceId,
            });
          }
        } else if (outcome === 'finish' || outcome === 'completed') {
          const finished = await query<{ completed: boolean }>(
            client,
            'select app.finish_preview_cleanup($1,$2,$3,$4) completed',
            [workspaceId, previewRunId, sequence, hash],
            signal,
          );
          result = Object.freeze({
            previewRunId,
            status:
              finished.rows[0]?.completed === true ? 'completed' : 'blocked',
            workspaceId,
          });
        } else {
          result = Object.freeze({
            previewRunId,
            status: outcome,
            workspaceId,
          });
        }
        await query(client, 'commit', [], signal);
        transactionComplete = true;
        return result;
      } catch (error: unknown) {
        destroyClient = true;
        if (!transactionComplete)
          await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release(destroyClient);
      }
    },
  });
}
