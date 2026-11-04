import {
  readFailedErrorWorkflowDeliveries,
  replaceFailedErrorWorkflowDelivery,
} from '../error-workflows/recovery.repository.js';
import {
  automaticReconciliationAction,
  overdueDeliveryAction,
} from '@pertexo/workflow-engine';
import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { RUN_DELIVERY_JOB_NAMES } from '../../outbox/delivery-consumers.js';
import {
  dateUndatedDeliveries,
  settleOverdueDeliveries,
} from '../../outbox/overdue-deliveries.repository.js';
import {
  readLockedAttempt,
  settleExpiredAttempt,
} from '../../attempts/attempt-reconciliation.repository.js';
import { enqueue } from '../../outbox/enqueue-delivery.repository.js';
import {
  rethrowQueryFailure,
  withWorkspaceTransaction,
  type WorkspaceTransaction,
} from '@pertexo/database/primitives';
import {
  nodeAttempts,
  nodeRuns,
  workflowRuns,
  outboxEvents,
} from '@pertexo/database/schema';
import type {
  StalledWorkFailure,
  StalledWorkRecovery,
  StalledWorkStageFailure,
} from './stalled-work.types.js';

/** A busy run holds its lock only briefly; the next scan tries again. */
const LOCK_TIMEOUT_MILLIS = 5_000;
const STATEMENT_TIMEOUT_MILLIS = 15_000;

/** Confirmed history must not queue ahead of lost jobs; each cycle is bounded. */
const DELIVERY_BATCH_SIZE = 1_000;
const MAXIMUM_DELIVERY_BATCHES_PER_CYCLE = 20;

/** Fail a hung query before the worker's five-minute scan-health deadline. */
export const STALLED_WORK_POOL_ROLE = 'worker';

export type StalledWorkStore = ReturnType<typeof createStalledWorkStore>;

/** Sweeps every workspace: no member behind it, so it stays off withWorkspaceAccess. */
export function createStalledWorkStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime, {
    role: STALLED_WORK_POOL_ROLE,
  });
  let undatedDeliveriesChecked = false;
  return Object.freeze({
    /** Isolate row and stage failures so other stranded work can recover. */
    recoverDue: async (limit: number, signal: AbortSignal) => {
      const result = await recoverDue(lease.pool, limit, signal);
      if (undatedDeliveriesChecked) return result;
      // Legacy discovery must not delay or roll back ordinary recovery.
      try {
        await dateAllUndatedDeliveries(lease.pool, signal);
        undatedDeliveriesChecked = true;
        return result;
      } catch (error: unknown) {
        signal.throwIfAborted();
        return Object.freeze({
          ...result,
          stagesFailed: Object.freeze([
            ...result.stagesFailed,
            { stage: 'undated_deliveries' as const, error },
          ]),
        });
      }
    },
    close: () => lease.close(),
  });
}

async function dateAllUndatedDeliveries(
  pool: Pool,
  signal: AbortSignal,
): Promise<void> {
  while (
    (await dateUndatedDeliveries(pool, DELIVERY_BATCH_SIZE)) ===
    DELIVERY_BATCH_SIZE
  )
    signal.throwIfAborted();
}

async function recoverDue(pool: Pool, limit: number, signal: AbortSignal) {
  const stagesFailed: StalledWorkStageFailure[] = [];
  const stage = async <T>(
    name: StalledWorkStageFailure['stage'],
    nothing: T,
    work: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await work();
    } catch (error: unknown) {
      signal.throwIfAborted();
      stagesFailed.push({ stage: name, error });
      return nothing;
    }
  };
  const attempts = await stage('expired_leases', [], () =>
    readExpiredLeases(pool, limit),
  );
  const recovered: StalledWorkRecovery[] = await stage(
    'overdue_deliveries',
    [],
    () => settleDeliveries(pool, signal),
  );
  const failedErrorDeliveries = await stage(
    'failed_error_workflow_deliveries',
    [],
    () => readFailedErrorWorkflowDeliveries(pool, limit),
  );
  const failedRunJobs = await stage('failed_run_jobs', [], () =>
    readFailedRunJobs(pool, limit),
  );
  const failed: StalledWorkFailure[] = [];
  const settle = async (
    workspaceId: string,
    targetId: string,
    work: (
      transaction: WorkspaceTransaction,
    ) => Promise<StalledWorkRecovery | undefined>,
  ): Promise<void> => {
    signal.throwIfAborted();
    try {
      const recovery = await inRecoveryTransaction(
        pool,
        workspaceId,
        signal,
        work,
      );
      if (recovery !== undefined) recovered.push(recovery);
    } catch (error: unknown) {
      signal.throwIfAborted();
      failed.push({ workspaceId, targetId, error });
    }
  };
  for (const attempt of attempts)
    await settle(attempt.workspaceId, attempt.attemptId, (transaction) =>
      recoverExpiredLease(transaction, attempt),
    );
  for (const delivery of failedRunJobs)
    await settle(delivery.workspaceId, delivery.id, (transaction) =>
      replaceFailedRunJob(transaction, delivery),
    );
  for (const delivery of failedErrorDeliveries)
    await settle(delivery.workspaceId, delivery.id, (transaction) =>
      replaceFailedErrorWorkflowDelivery(transaction, delivery),
    );
  return Object.freeze({
    recovered: Object.freeze(recovered),
    failed: Object.freeze(failed),
    stagesFailed: Object.freeze(stagesFailed),
  });
}

function inRecoveryTransaction<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  work: (transaction: WorkspaceTransaction) => Promise<T>,
): Promise<T> {
  return withWorkspaceTransaction(
    pool,
    workspaceId,
    async (transaction) => {
      await transaction.db.execute(
        sql`select set_config('lock_timeout', ${String(LOCK_TIMEOUT_MILLIS)}, true)`,
      );
      return work(transaction);
    },
    { signal, statementTimeoutMillis: STATEMENT_TIMEOUT_MILLIS },
  );
}

type ExpiredLease = Readonly<{
  workspaceId: string;
  attemptId: string;
  fenceToken: number;
}>;

function readExpiredLeases(
  pool: Pool,
  limit: number,
): Promise<readonly ExpiredLease[]> {
  return drizzle(pool)
    .select({
      workspaceId: nodeAttempts.workspaceId,
      attemptId: nodeAttempts.id,
      fenceToken: nodeAttempts.fenceToken,
    })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.status, 'running'),
        isNotNull(nodeAttempts.leaseExpiresAt),
        lte(nodeAttempts.leaseExpiresAt, sql`clock_timestamp()`),
      ),
    )
    .orderBy(asc(nodeAttempts.leaseExpiresAt), asc(nodeAttempts.id))
    .limit(limit)
    .catch(rethrowQueryFailure);
}

async function recoverExpiredLease(
  transaction: WorkspaceTransaction,
  candidate: ExpiredLease,
): Promise<StalledWorkRecovery | undefined> {
  const attempt = await readLockedAttempt(transaction, candidate.attemptId);
  if (attempt === undefined) return undefined;
  const { outcome } = await settleExpiredAttempt(transaction, attempt, {
    attemptId: candidate.attemptId,
    expectedFenceToken: candidate.fenceToken,
    action: automaticReconciliationAction(attempt),
    dryRun: false,
    source: { stalledWorkRecovery: true },
  });
  if (outcome !== 'reclaimed' && outcome !== 'marked_unknown') return undefined;
  return Object.freeze({
    kind:
      outcome === 'reclaimed' ? 'attempt_reclaimed' : 'attempt_marked_unknown',
    workspaceId: candidate.workspaceId,
    runId: attempt.runId,
    attemptId: candidate.attemptId,
  });
}

async function settleDeliveries(
  pool: Pool,
  signal: AbortSignal,
): Promise<StalledWorkRecovery[]> {
  const recovered: StalledWorkRecovery[] = [];
  for (let batch = 0; batch < MAXIMUM_DELIVERY_BATCHES_PER_CYCLE; batch += 1) {
    signal.throwIfAborted();
    const { settled, asked } = await settleOverdueDeliveries(
      pool,
      DELIVERY_BATCH_SIZE,
    );
    for (const delivery of asked)
      recovered.push(
        Object.freeze({
          kind: delivery.gaveUp ? 'delivery_given_up' : 'delivery_redelivered',
          workspaceId: delivery.workspaceId,
          outboxEventId: delivery.outboxEventId,
          jobName: delivery.jobName,
          aggregateId: delivery.aggregateId,
          redeliveries: delivery.redeliveries,
        }),
      );
    if (settled < DELIVERY_BATCH_SIZE) break;
  }
  return recovered;
}

type FailedRunJob = Readonly<{
  id: string;
  workspaceId: string;
  jobName: string;
  aggregateId: string;
}>;

/** A run job that can't be published or confirmed: a run still waits on it. */
function readFailedRunJobs(
  pool: Pool,
  limit: number,
): Promise<readonly FailedRunJob[]> {
  return drizzle(pool)
    .select({
      id: outboxEvents.id,
      workspaceId: outboxEvents.workspaceId,
      jobName: outboxEvents.jobName,
      aggregateId: outboxEvents.aggregateId,
    })
    .from(outboxEvents)
    .where(
      and(
        lte(outboxEvents.deliveryDueAt, sql`clock_timestamp()`),
        isNotNull(outboxEvents.failedAt),
        inArray(outboxEvents.jobName, RUN_DELIVERY_JOB_NAMES),
      ),
    )
    .orderBy(asc(outboxEvents.deliveryDueAt), asc(outboxEvents.id))
    .limit(limit)
    .catch(rethrowQueryFailure);
}

async function replaceFailedRunJob(
  transaction: WorkspaceTransaction,
  delivery: FailedRunJob,
): Promise<StalledWorkRecovery | undefined> {
  const { db, workspaceId } = transaction;
  const attemptOwner = await readAttemptOwner(transaction, delivery);
  const runId = attemptOwner?.runId ?? delivery.aggregateId;
  // Every run writer locks the run before its attempt and node.
  const [run] = await db
    .select({ status: workflowRuns.status })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, workspaceId),
        eq(workflowRuns.id, runId),
      ),
    )
    .for('update');
  const attempt =
    attemptOwner === undefined
      ? undefined
      : await readLockedAttempt(transaction, delivery.aggregateId);
  // Re-read under the lock: another worker's scan may have just replaced it.
  const [event] = await db
    .select({ payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.workspaceId, workspaceId),
        eq(outboxEvents.id, delivery.id),
        lte(outboxEvents.deliveryDueAt, sql`clock_timestamp()`),
      ),
    )
    .for('update');
  if (event === undefined) return undefined;
  await db
    .update(outboxEvents)
    .set({ deliveryDueAt: null, updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(outboxEvents.workspaceId, workspaceId),
        eq(outboxEvents.id, delivery.id),
      ),
    );
  const action = overdueDeliveryAction({
    runStatus: run?.status,
    attemptStatus: attempt?.status,
    jobName: delivery.jobName,
  });
  if (action === 'drop') return undefined;
  const outboxEventId = await enqueue(transaction, {
    jobName: delivery.jobName,
    aggregateType: attemptOwner === undefined ? 'workflow-run' : 'node-attempt',
    aggregateId: delivery.aggregateId,
    fields:
      attemptOwner === undefined
        ? { runId }
        : {
            attemptId: delivery.aggregateId,
            nodeRunId: attemptOwner.nodeRunId,
            runId,
          },
  });
  return Object.freeze({
    kind: 'delivery_replaced',
    workspaceId,
    runId,
    jobName: delivery.jobName,
    replacedEventId: delivery.id,
    outboxEventId,
  });
}

async function readAttemptOwner(
  transaction: WorkspaceTransaction,
  delivery: FailedRunJob,
) {
  if (delivery.jobName !== 'execute-node-attempt') return undefined;
  const [owner] = await transaction.db
    .select({ nodeRunId: nodeRuns.id, runId: nodeRuns.workflowRunId })
    .from(nodeAttempts)
    .innerJoin(
      nodeRuns,
      and(
        eq(nodeRuns.workspaceId, nodeAttempts.workspaceId),
        eq(nodeRuns.id, nodeAttempts.nodeRunId),
      ),
    )
    .where(
      and(
        eq(nodeAttempts.workspaceId, transaction.workspaceId),
        eq(nodeAttempts.id, delivery.aggregateId),
      ),
    );
  return owner;
}
