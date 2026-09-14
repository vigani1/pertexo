import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import type { ControlLedger } from './control-ledger-coordinator.js';
import { retentionQuery as query } from './retention-support.js';
import {
  inRetentionTransaction,
  withWorkspaceDestructiveAuthorization,
} from './retention-transaction.js';

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

export function createRunArtifactRetentionCoordinator(
  config: DatabaseConfig,
  ledger: ControlLedger,
  artifacts: RunArtifactRetentionStore,
  inputOptions: RunArtifactRetentionCoordinatorOptions = {},
  runtime?: DatabaseRuntime,
): RunArtifactRetentionCoordinator {
  if (config.max < 2)
    throw new RangeError(
      'Run artifact retention coordination requires a database pool of at least 2 connections',
    );
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;

  return Object.freeze({
    close: () => lease.close(),
    processNext: async (signal?: AbortSignal) => {
      const transactionOptions = {
        lockTimeoutMs: options.lockTimeoutMs,
        statementTimeoutMs: options.statementTimeoutMs,
      };
      const due = await inRetentionTransaction(
        pool,
        transactionOptions,
        signal,
        (client) =>
          query<{ artifact_id: string; workspace_id: string }>(
            client,
            'select * from app.find_due_run_artifact_retention(1)',
            [],
            signal,
          ),
      );
      const candidate = due.rows[0];
      if (candidate === undefined)
        return Object.freeze({ status: 'idle' as const });
      const artifactId = uuidSchema.parse(candidate.artifact_id);
      const workspaceId = uuidSchema.parse(candidate.workspace_id);
      const authorization = await withWorkspaceDestructiveAuthorization(
        pool,
        transactionOptions,
        signal,
        workspaceId,
        ledger,
        options.externalOperationTimeoutMs,
        async (highWater, externalSignal) => {
          const outcome = await inRetentionTransaction(
            pool,
            transactionOptions,
            signal,
            async (client) => {
              await query(
                client,
                "select set_config('app.workspace_id',$1,true)",
                [workspaceId],
                signal,
              );
              const prepared = await query<{ outcome: string }>(
                client,
                'select app.prepare_run_artifact_retention($1,$2,$3,$4) outcome',
                [workspaceId, artifactId, highWater.sequence, highWater.hash],
                signal,
              );
              return z
                .enum(['artifact', 'held', 'referenced', 'stale'])
                .parse(prepared.rows[0]?.outcome);
            },
          );
          if (outcome !== 'artifact')
            return Object.freeze({ artifactId, status: outcome, workspaceId });
          const defer = async (): Promise<boolean> =>
            inRetentionTransaction(
              pool,
              transactionOptions,
              signal,
              async (client) => {
                await query(
                  client,
                  "select set_config('app.workspace_id',$1,true)",
                  [workspaceId],
                  signal,
                );
                const deferred = await query<{ deferred: boolean }>(
                  client,
                  'select app.defer_run_artifact_retention($1,$2,$3,$4) deferred',
                  [workspaceId, artifactId, highWater.sequence, highWater.hash],
                  signal,
                );
                return z.boolean().parse(deferred.rows[0]?.deferred);
              },
            );

          let remaining: object | null;
          try {
            await artifacts.delete({
              artifactId,
              signal: externalSignal,
              workspaceId,
            });
            remaining = await artifacts.head({
              artifactId,
              signal: externalSignal,
              workspaceId,
            });
          } catch (error: unknown) {
            signal?.throwIfAborted();
            try {
              if (!(await defer()))
                throw new Error('Run artifact retention deferral was lost');
            } catch (deferError: unknown) {
              throw new AggregateError(
                [error, deferError],
                'Run artifact retention failure and deferral both failed',
              );
            }
            throw error;
          }
          if (remaining !== null) {
            if (!(await defer()))
              throw new Error('Run artifact retention deferral was lost');
            return Object.freeze({
              artifactId,
              status: 'waiting' as const,
              workspaceId,
            });
          }

          const completed = await inRetentionTransaction(
            pool,
            transactionOptions,
            signal,
            async (client) => {
              await query(
                client,
                "select set_config('app.workspace_id',$1,true)",
                [workspaceId],
                signal,
              );
              const completed = await query<{ completed: boolean }>(
                client,
                'select app.complete_run_artifact_retention($1,$2,$3,$4) completed',
                [workspaceId, artifactId, highWater.sequence, highWater.hash],
                signal,
              );
              return z.boolean().parse(completed.rows[0]?.completed);
            },
          );
          if (!completed)
            throw new Error('Run artifact retention completion was lost');
          return Object.freeze({
            artifactId,
            status: 'completed' as const,
            workspaceId,
          });
        },
      );
      if (authorization.status === 'stale')
        return Object.freeze({
          artifactId,
          status: 'released' as const,
          workspaceId,
        });
      return authorization.value;
    },
  });
}
