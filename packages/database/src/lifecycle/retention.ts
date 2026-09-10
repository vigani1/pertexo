import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import type { ControlLedger } from './control-ledger-coordinator.js';
import {
  inRetentionTransaction,
  lockWorkspaceRetentionControl,
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
    ...createRetentionHealthCapability(pool),
    ...createRetentionOperatorRecoveryCapability(pool),
    ...createRetentionSchedulingCapability(pool),
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
  const options = enforcementOptionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;

  const claim = async (signal?: AbortSignal) => {
    const result = await query(
      pool,
      'select * from app.claim_retention_destructive_batches($1,1,$2)',
      [options.leaseOwner, options.leaseSeconds],
      signal,
    );
    return result.rows.map(mapClaim)[0];
  };

  const release = async (
    claimed: RetentionDryRunClaim,
    signal?: AbortSignal,
  ): Promise<void> => {
    await query(
      pool,
      'select app.release_retention_batch($1,$2,$3)',
      [claimed.batchId, claimed.leaseToken, claimed.leaseFence],
      signal,
    );
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
          const highWater = await lockWorkspaceRetentionControl(
            pool,
            options,
            signal,
            claimed.workspaceId,
            'Retention workspace control lock was not returned',
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
            workspaceId: claimed.workspaceId,
          });
          if (
            !reconciliation.reachedHighWater ||
            reconciliation.hasMore ||
            reconciliation.records.length !== 0 ||
            reconciliation.pageEndSequence !== highWater.sequence ||
            reconciliation.pageEndHash !== highWater.hash
          ) {
            throw new Error(
              'Retention control ledger is not exactly projected',
            );
          }
          const row = await inRetentionTransaction(
            pool,
            options,
            signal,
            async (client) => {
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
                z.coerce.number().parse(current.retention_control_sequence) !==
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
                throw new Error('Destructive retention page was not returned');
              return row;
            },
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
        } catch {
          await release(claimed, signal).catch(() => undefined);
          return Object.freeze({
            batchId: claimed.batchId,
            eligibleCount,
            examinedCount,
            pageCount,
            retentionKind: claimed.retentionKind,
            status: 'released' as const,
            workspaceId: claimed.workspaceId,
          });
        }
      }
      await release(claimed, signal);
      return Object.freeze({
        batchId: claimed.batchId,
        eligibleCount,
        examinedCount,
        pageCount: options.maxPagesPerBatch,
        retentionKind: claimed.retentionKind,
        status: 'released' as const,
        workspaceId: claimed.workspaceId,
      });
    },
  });
}
