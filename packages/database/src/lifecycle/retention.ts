import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import type { ControlLedger } from './control-ledger-coordinator.js';
import {
  inRetentionTransaction,
  withWorkspaceDestructiveAuthorization,
} from './retention-transaction.js';
import type {
  RetentionDatabase,
  RetentionDatabaseOptions,
  RetentionDryRunClaim,
  RetentionEnforcementCoordinator,
  RetentionEnforcementCoordinatorOptions,
} from './retention-contracts.js';
export type {
  OperatorMaintenanceRerunResult,
  RegionalReplicaLagObservation,
  RetentionDatabase,
  RetentionDatabaseOptions,
  RetentionDryRunClaim,
  RetentionDryRunPageResult,
  RetentionDryRunProcessResult,
  RetentionDryRunTuple,
  RetentionEnforcementCoordinator,
  RetentionEnforcementCoordinatorOptions,
  RetentionEnforcementProcessResult,
  RetentionKind,
  RetentionScheduleResult,
  StartWorkflowRunInputRetentionDryRunInput,
  StartWorkflowRunInputRetentionInput,
} from './retention-contracts.js';
import {
  createRetentionDryRunCapability,
  createRetentionHealthCapability,
  createRetentionOperatorRecoveryCapability,
  createRetentionSchedulingCapability,
} from './retention-database-capabilities.js';
import {
  mapRetentionDryRunClaim as mapClaim,
  parseRetentionDatabaseOptions,
  retentionOptionsSchema as optionsSchema,
  retentionQuery as query,
} from './retention-support.js';

export function createRetentionDatabase(
  config: DatabaseConfig,
  inputOptions: RetentionDatabaseOptions,
  runtime?: DatabaseRuntime,
): RetentionDatabase {
  const options = parseRetentionDatabaseOptions(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;
  return Object.freeze({
    ...createRetentionDryRunCapability(pool, options),
    ...createRetentionHealthCapability(pool, options),
    ...createRetentionOperatorRecoveryCapability(pool, options),
    ...createRetentionSchedulingCapability(pool, options),
    close: () => lease.close(),
  });
}

const enforcementOptionsSchema = optionsSchema.extend({
  externalOperationTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(30_000),
  lockTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
  statementTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
});

export function createRetentionEnforcementCoordinator(
  config: DatabaseConfig,
  ledger: ControlLedger,
  inputOptions: RetentionEnforcementCoordinatorOptions,
  runtime?: DatabaseRuntime,
): RetentionEnforcementCoordinator {
  if (config.max < 2)
    throw new RangeError(
      'Retention enforcement coordination requires a database pool of at least 2 connections',
    );
  const options = enforcementOptionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;

  const claim = async (signal?: AbortSignal) => {
    return inRetentionTransaction(pool, options, signal, async (client) => {
      const result = await query(
        client,
        'select * from app.claim_retention_destructive_batches($1,1,$2)',
        [options.leaseOwner, options.leaseSeconds],
        signal,
      );
      return result.rows.map(mapClaim)[0];
    });
  };

  const release = async (
    claimed: RetentionDryRunClaim,
    signal?: AbortSignal,
  ): Promise<boolean> =>
    inRetentionTransaction(pool, options, signal, async (client) => {
      const result = await query<{ released: boolean }>(
        client,
        'select app.release_retention_batch($1,$2,$3) released',
        [claimed.batchId, claimed.leaseToken, claimed.leaseFence],
        signal,
      );
      return z.boolean().parse(result.rows[0]?.released);
    });

  const releaseResult = (
    claimed: RetentionDryRunClaim,
    eligibleCount: number,
    examinedCount: number,
    pageCount: number,
    released: boolean,
  ) =>
    Object.freeze({
      batchId: claimed.batchId,
      eligibleCount,
      examinedCount,
      pageCount,
      retentionKind: claimed.retentionKind,
      status: released ? ('released' as const) : ('stale' as const),
      workspaceId: claimed.workspaceId,
    });

  const releaseAfterFailure = async (
    claimed: RetentionDryRunClaim,
    error: unknown,
    operationSignal?: AbortSignal,
  ): Promise<never> => {
    const cleanupSignal = AbortSignal.timeout(options.statementTimeoutMs);
    try {
      await release(claimed, cleanupSignal);
    } catch (releaseError: unknown) {
      throw new AggregateError(
        [error, releaseError],
        'Retention page failure and lease cleanup both failed',
      );
    }
    if (operationSignal?.aborted === true) operationSignal.throwIfAborted();
    throw error;
  };

  return Object.freeze({
    close: () => lease.close(),
    processNext: async (signal?: AbortSignal) => {
      const claimed = await claim(signal);
      if (claimed === undefined) return { status: 'idle' as const };
      let examinedCount = 0;
      let eligibleCount = 0;
      for (
        let pageCount = 1;
        pageCount <= options.maxPagesPerBatch;
        pageCount += 1
      ) {
        try {
          const authorization = await withWorkspaceDestructiveAuthorization(
            pool,
            options,
            signal,
            claimed.workspaceId,
            ledger,
            options.externalOperationTimeoutMs,
            async (highWater) =>
              inRetentionTransaction(pool, options, signal, async (client) => {
                const lock = await query<{
                  retention_control_hash: string;
                  retention_control_sequence: string | number;
                }>(
                  client,
                  'select * from app.lock_workspace_control_ledger($1)',
                  [claimed.workspaceId],
                  signal,
                );
                const current = lock.rows[0];
                if (
                  current === undefined ||
                  z.coerce
                    .number()
                    .parse(current.retention_control_sequence) !==
                    highWater.sequence ||
                  current.retention_control_hash !== highWater.hash
                )
                  throw new Error('Retention control fence changed');
                const page = await query<{
                  cursor_expires_at: Date | string | null;
                  cursor_id: string | null;
                  eligible_delta: string | number;
                  examined_delta: string | number;
                  outcome: string;
                }>(
                  client,
                  claimed.retentionKind === 'workflow_run_input'
                    ? `select * from app.execute_workflow_run_input_retention_page(
                      $1,$2,$3,$4,$5,$6)`
                    : `select * from app.execute_standard_retention_page(
                      $1,$2,$3,$4,$5,$6)`,
                  [
                    claimed.batchId,
                    claimed.leaseToken,
                    claimed.leaseFence,
                    options.pageSize,
                    highWater.sequence,
                    highWater.hash,
                  ],
                  signal,
                );
                const row = page.rows[0];
                if (row === undefined)
                  throw new Error(
                    'Destructive retention page was not returned',
                  );
                const outcome = z
                  .enum(['completed', 'paused', 'progressed', 'stale'])
                  .parse(row.outcome);
                const examinedDelta = z.coerce
                  .number()
                  .int()
                  .nonnegative()
                  .parse(row.examined_delta);
                const eligibleDelta = z.coerce
                  .number()
                  .int()
                  .nonnegative()
                  .parse(row.eligible_delta);
                if (eligibleDelta > examinedDelta)
                  throw new Error(
                    'Retention page eligible count exceeds examined count',
                  );
                return Object.freeze({
                  eligibleDelta,
                  examinedDelta,
                  outcome,
                });
              }),
          );
          if (authorization.status === 'stale') {
            return releaseResult(
              claimed,
              eligibleCount,
              examinedCount,
              pageCount,
              await release(claimed, signal),
            );
          }
          const { eligibleDelta, examinedDelta, outcome } = authorization.value;
          examinedCount += examinedDelta;
          eligibleCount += eligibleDelta;
          if (outcome !== 'progressed') {
            return Object.freeze({
              batchId: claimed.batchId,
              eligibleCount,
              examinedCount,
              pageCount,
              retentionKind: claimed.retentionKind,
              status: outcome,
              workspaceId: claimed.workspaceId,
            });
          }
        } catch (error: unknown) {
          return releaseAfterFailure(claimed, error, signal);
        }
      }
      return releaseResult(
        claimed,
        eligibleCount,
        examinedCount,
        options.maxPagesPerBatch,
        await release(claimed, signal),
      );
    },
  });
}
