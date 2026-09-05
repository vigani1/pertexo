import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import type { Pool } from 'pg';
import type { PoolClient, QueryResult } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import type { ControlLedger } from './control-ledger-coordinator.js';

const uuidSchema = z.uuid();

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
      status:
        'completed' | 'held' | 'referenced' | 'released' | 'stale' | 'waiting';
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

export function createRunArtifactRetentionCoordinator(
  config: DatabaseConfig,
  ledger: ControlLedger,
  artifacts: RunArtifactRetentionStore,
  inputOptions: RunArtifactRetentionCoordinatorOptions = {},
  runtime?: DatabaseRuntime,
): RunArtifactRetentionCoordinator {
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;

  return Object.freeze({
    close: () => lease.close(),
    processNext: async (signal?: AbortSignal) => {
      const due = await query<{ artifact_id: string; workspace_id: string }>(
        pool,
        'select * from app.find_due_run_artifact_retention(1)',
        [],
        signal,
      );
      const candidate = due.rows[0];
      if (candidate === undefined)
        return Object.freeze({ status: 'idle' as const });
      const artifactId = uuidSchema.parse(candidate.artifact_id);
      const workspaceId = uuidSchema.parse(candidate.workspace_id);
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
          retention_control_sequence: number | string;
        }>(
          client,
          'select * from app.lock_workspace_control_ledger($1)',
          [workspaceId],
          signal,
        );
        const highWater = locked.rows[0];
        if (highWater === undefined)
          throw new Error(
            'Run artifact workspace control lock was not returned',
          );
        const sequence = z.coerce
          .number()
          .int()
          .nonnegative()
          .parse(highWater.retention_control_sequence);
        const hash = z
          .string()
          .regex(/^[0-9a-f]{64}$/u)
          .parse(highWater.retention_control_hash);
        await query(
          client,
          "select set_config('app.workspace_id',$1,true)",
          [workspaceId],
          signal,
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
          projectedHash: hash,
          projectedSequence: sequence,
          signal: externalSignal,
          workspaceId,
        });
        if (
          !reconciliation.reachedHighWater ||
          reconciliation.hasMore ||
          reconciliation.records.length !== 0 ||
          reconciliation.pageEndSequence !== sequence ||
          reconciliation.pageEndHash !== hash
        ) {
          await query(client, 'rollback', [], signal);
          transactionComplete = true;
          return Object.freeze({
            artifactId,
            status: 'released' as const,
            workspaceId,
          });
        }
        const prepared = await query<{ outcome: string }>(
          client,
          'select app.prepare_run_artifact_retention($1,$2,$3,$4) outcome',
          [workspaceId, artifactId, sequence, hash],
          signal,
        );
        const outcome = z
          .enum(['artifact', 'held', 'referenced', 'stale'])
          .parse(prepared.rows[0]?.outcome);
        if (outcome !== 'artifact') {
          await query(client, 'commit', [], signal);
          transactionComplete = true;
          return Object.freeze({ artifactId, status: outcome, workspaceId });
        }
        await artifacts.delete({
          artifactId,
          signal: externalSignal,
          workspaceId,
        });
        if (
          (await artifacts.head({
            artifactId,
            signal: externalSignal,
            workspaceId,
          })) !== null
        ) {
          const deferred = await query<{ deferred: boolean }>(
            client,
            'select app.defer_run_artifact_retention($1,$2,$3,$4) deferred',
            [workspaceId, artifactId, sequence, hash],
            signal,
          );
          if (deferred.rows[0]?.deferred !== true)
            throw new Error('Run artifact retention deferral was lost');
          await query(client, 'commit', [], signal);
          transactionComplete = true;
          return Object.freeze({
            artifactId,
            status: 'waiting' as const,
            workspaceId,
          });
        }
        const completed = await query<{ completed: boolean }>(
          client,
          'select app.complete_run_artifact_retention($1,$2,$3,$4) completed',
          [workspaceId, artifactId, sequence, hash],
          signal,
        );
        if (completed.rows[0]?.completed !== true)
          throw new Error('Run artifact retention completion was lost');
        await query(client, 'commit', [], signal);
        transactionComplete = true;
        return Object.freeze({
          artifactId,
          status: 'completed' as const,
          workspaceId,
        });
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
