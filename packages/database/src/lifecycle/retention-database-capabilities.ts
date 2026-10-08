import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { checkDatabaseReadiness } from '../platform/readiness.js';
import { inRetentionTransaction } from './retention-transaction.js';
import { reapTransientData } from './transient-data-retention.js';
import type {
  OperatorMaintenanceRerunResult,
  RetentionDatabase,
  RetentionDryRunClaim,
  RetentionDryRunPageResult,
  RetentionDryRunProcessResult,
  RetentionScheduleResult,
  StartWorkflowRunInputRetentionInput,
} from './retention-contracts.js';
import {
  mapRetentionDryRunClaim,
  type ParsedRetentionDatabaseOptions,
  retentionBoundedText,
  retentionDateSchema,
  retentionKindSchema,
  retentionQuery as query,
  retentionUuidSchema as uuidSchema,
} from './retention-support.js';

const RETENTION_SCHEDULE_BATCH_SIZE = 25;

function transact<T>(
  pool: Pool,
  options: ParsedRetentionDatabaseOptions,
  signal: AbortSignal | undefined,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inRetentionTransaction(pool, options, signal, work);
}

type DryRunCapability = Pick<
  RetentionDatabase,
  | 'claimDryRuns'
  | 'executeDryRunPage'
  | 'processNext'
  | 'reapTransientData'
  | 'startDryRun'
  | 'startEnforcement'
>;

export function createRetentionDryRunCapability(
  pool: Pool,
  options: ParsedRetentionDatabaseOptions,
): DryRunCapability {
  const claim = async (signal?: AbortSignal) => {
    return transact(pool, options, signal, async (client) => {
      const result = await query(
        client,
        'select * from app.claim_retention_dry_run_batches($1,$2,$3)',
        [options.leaseOwner, 1, options.leaseSeconds],
        signal,
      );
      return result.rows.map(mapRetentionDryRunClaim);
    });
  };
  const executeDryRunPage = async (
    claimed: RetentionDryRunClaim,
    signal?: AbortSignal,
  ): Promise<RetentionDryRunPageResult> => {
    const standard = claimed.retentionKind !== 'workflow_run_input';
    return transact(pool, options, signal, async (client) => {
      const result = await query(
        client,
        standard
          ? `select * from app.execute_standard_retention_dry_run_page(
          $1::uuid,$2::uuid,$3::bigint,$4::integer)`
          : `select * from app.execute_workflow_run_input_retention_dry_run_page(
        $1::uuid,$2::uuid,$3::bigint,$4::integer)`,
        [
          claimed.batchId,
          claimed.leaseToken,
          claimed.leaseFence,
          options.pageSize,
        ],
        signal,
      );
      const row = result.rows[0];
      if (row === undefined)
        throw new Error('Retention dry-run page was not returned');
      const examinedDelta = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(row.examined_delta);
      const eligibleDelta = z.coerce
        .number()
        .int()
        .nonnegative()
        .max(examinedDelta)
        .parse(row.eligible_delta);
      let outcome: 'completed' | 'progressed' | 'stale';
      if (standard) {
        outcome = z
          .enum(['completed', 'progressed', 'stale'])
          .parse(row.outcome);
      } else if (z.boolean().parse(row.completed)) {
        outcome = 'completed';
      } else if (
        examinedDelta === 0 &&
        eligibleDelta === 0 &&
        row.cursor_expires_at === null &&
        row.cursor_id === null
      ) {
        outcome = 'stale';
      } else {
        outcome = 'progressed';
      }
      return Object.freeze({
        completed: outcome === 'completed',
        cursorExpiresAt:
          row.cursor_expires_at === null || row.cursor_expires_at === undefined
            ? null
            : z.coerce.date().parse(row.cursor_expires_at),
        cursorId:
          row.cursor_id === null || row.cursor_id === undefined
            ? null
            : uuidSchema.parse(row.cursor_id),
        eligibleDelta,
        examinedDelta,
        outcome,
        stale: outcome === 'stale',
      });
    });
  };
  const releaseDryRun = async (
    claimed: RetentionDryRunClaim,
    signal: AbortSignal,
  ): Promise<boolean> =>
    transact(pool, options, signal, async (client) => {
      const result = await query<{ released: boolean }>(
        client,
        'select app.release_retention_batch($1,$2,$3) released',
        [claimed.batchId, claimed.leaseToken, claimed.leaseFence],
        signal,
      );
      return z.boolean().parse(result.rows[0]?.released);
    });
  const startBatch = async (
    input: StartWorkflowRunInputRetentionInput,
    dryRun: boolean,
  ) => {
    const parsed = z
      .object({
        batchId: uuidSchema,
        cutoffAt: retentionDateSchema,
        idempotencyKey: retentionBoundedText(128),
        reason: retentionBoundedText(512),
        requestedBy: retentionBoundedText(128),
        retentionKind: retentionKindSchema.default('workflow_run_input'),
        signal: z
          .custom<AbortSignal>((value) => value instanceof AbortSignal)
          .optional(),
        workspaceId: uuidSchema,
      })
      .strict()
      .parse(input);
    return transact(pool, options, parsed.signal, async (client) => {
      const result = await query<{ batch_id: string }>(
        client,
        `select app.start_retention_batch(
        $1::uuid,$2::uuid,$3::varchar,$4::varchar,
        $5::timestamptz,$6::boolean,$7::varchar,$8::varchar) batch_id`,
        [
          parsed.batchId,
          parsed.workspaceId,
          parsed.idempotencyKey,
          parsed.retentionKind,
          parsed.cutoffAt,
          dryRun,
          parsed.requestedBy,
          parsed.reason,
        ],
        parsed.signal,
      );
      return uuidSchema.parse(result.rows[0]?.batch_id);
    });
  };
  const processNext = async (
    signal?: AbortSignal,
  ): Promise<RetentionDryRunProcessResult> => {
    const claimed = (await claim(signal))[0];
    if (claimed === undefined) return { status: 'idle' };
    let eligibleCount = 0;
    let examinedCount = 0;
    for (
      let pageCount = 1;
      pageCount <= options.maxPagesPerBatch;
      pageCount++
    ) {
      signal?.throwIfAborted();
      const page = await executeDryRunPage(claimed, signal);
      eligibleCount += page.eligibleDelta;
      examinedCount += page.examinedDelta;
      if (page.completed || page.stale)
        return Object.freeze({
          batchId: claimed.batchId,
          eligibleCount,
          examinedCount,
          pageCount,
          retentionKind: claimed.retentionKind,
          status: page.completed ? 'completed' : 'stale',
          workspaceId: claimed.workspaceId,
        });
    }
    const boundError = new Error('Retention dry-run page bound exceeded');
    try {
      await releaseDryRun(
        claimed,
        AbortSignal.timeout(options.statementTimeoutMs),
      );
    } catch (releaseError: unknown) {
      throw new AggregateError(
        [boundError, releaseError],
        'Retention dry-run page bound and lease cleanup both failed',
      );
    }
    throw boundError;
  };
  return Object.freeze({
    claimDryRuns: claim,
    executeDryRunPage,
    processNext,
    reapTransientData: (signal?: AbortSignal) =>
      reapTransientData(pool, options, signal),
    startDryRun: (input: StartWorkflowRunInputRetentionInput) =>
      startBatch(input, true),
    startEnforcement: (input: StartWorkflowRunInputRetentionInput) =>
      startBatch(input, false),
  });
}

export function createRetentionOperatorRecoveryCapability(
  pool: Pool,
  options: ParsedRetentionDatabaseOptions,
): Pick<RetentionDatabase, 'processOperatorRerun'> {
  return Object.freeze({
    processOperatorRerun: async (
      signal?: AbortSignal,
    ): Promise<OperatorMaintenanceRerunResult | null> => {
      return transact(pool, options, signal, async (client) => {
        const result = await query(
          client,
          'select * from app.process_operator_maintenance_rerun()',
          [],
          signal,
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        return Object.freeze({
          commandId: uuidSchema.parse(row.command_id),
          outcome: z
            .string()
            .regex(/^[a-z][a-z0-9_]{0,31}$/u)
            .parse(row.outcome),
          targetId: uuidSchema.parse(row.target_id),
          targetType: z
            .enum(['retention_batch', 'workspace_purge_job'])
            .parse(row.target_type),
          workspaceId: uuidSchema.parse(row.workspace_id),
        });
      });
    },
  });
}

export function createRetentionSchedulingCapability(
  pool: Pool,
  options: ParsedRetentionDatabaseOptions,
): Pick<RetentionDatabase, 'scheduleEnforcement'> {
  return Object.freeze({
    scheduleEnforcement: async (
      signal?: AbortSignal,
    ): Promise<RetentionScheduleResult> => {
      return transact(pool, options, signal, async (client) => {
        const result = await query<{
          cutoff_at: Date | string;
          scanned_count: number | string;
          scheduled_count: number | string;
        }>(
          client,
          'select * from app.schedule_workflow_run_input_retention($1)',
          [RETENTION_SCHEDULE_BATCH_SIZE],
          signal,
        );
        const row = result.rows[0];
        if (row === undefined)
          throw new Error('Retention schedule result was not returned');
        const scannedCount = z.coerce
          .number()
          .int()
          .min(0)
          .max(RETENTION_SCHEDULE_BATCH_SIZE)
          .parse(row.scanned_count);
        const scheduledCount = z.coerce
          .number()
          .int()
          .min(0)
          .max(scannedCount)
          .parse(row.scheduled_count);
        return Object.freeze({
          capacityLimited: scannedCount === RETENTION_SCHEDULE_BATCH_SIZE,
          cutoffAt: z.coerce.date().parse(row.cutoff_at),
          scannedCount,
          scheduledCount,
        });
      });
    },
  });
}

export function createRetentionHealthCapability(
  pool: Pool,
): Pick<RetentionDatabase, 'checkReadiness'> {
  return Object.freeze({
    checkReadiness: async (signal) => {
      signal?.throwIfAborted();
      await checkDatabaseReadiness(pool);
    },
  });
}
