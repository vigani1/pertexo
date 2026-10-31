import {
  automaticReconciliationAction,
  overdueDeliveryAction,
} from '@pertexo/workflow-engine';
import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../../config.js';
import { RUN_DELIVERY_JOB_NAMES } from '../../outbox/dispatcher/repository.js';
import {
  dateUndatedDeliveries,
  settleOverdueDeliveries,
} from '../../outbox/overdue-deliveries.repository.js';
import {
  readLockedAttempt,
  settleExpiredAttempt,
} from '../../operator/handlers/attempts.repository.js';
import { enqueue } from '../../operator/handlers/enqueue.js';
import { acquireDatabasePool } from '../../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import {
  nodeAttempts,
  nodeRuns,
  workflowRuns,
} from '../../schema/runs/execution.js';
import { outboxEvents } from '../../schema/transport.js';
import {
  withWorkspaceTransaction,
  type WorkspaceTransaction,
} from '../../tenant-access/transactions.js';
import type {
  StalledWorkFailure,
  StalledWorkRecovery,
  StalledWorkStore,
} from './contract.js';

/** A busy run holds its lock only briefly; the next scan tries again. */
const LOCK_TIMEOUT_MILLIS = 5_000;
const STATEMENT_TIMEOUT_MILLIS = 15_000;

/**
 * Well above what a worker can consume, so confirmed rows never queue up ahead of
 * a lost job. The bound only keeps one cycle from running without end.
 */
const DELIVERY_BATCH_SIZE = 1_000;
const MAXIMUM_DELIVERY_BATCHES_PER_CYCLE = 20;

/**
 * The worker's health check ends a worker whose scan hasn't settled in 5 minutes,
 * so a hung PostgreSQL has to fail the scan well before that, or an outage would
 * restart the worker. The scan's statements are small and don't need a maintenance
 * job's budget.
 */
export const STALLED_WORK_POOL_ROLE = 'worker';

export function createStalledWorkStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): StalledWorkStore {
  const lease = acquireDatabasePool(config, runtime, {
    role: STALLED_WORK_POOL_ROLE,
  });
  let undatedDeliveriesChecked = false;
  return Object.freeze({
    recoverDue: async (limit: number, signal: AbortSignal) => {
      const result = await recoverDue(lease.pool, limit, signal);
      // After the work above, so a slow first look at the table delays nothing.
      if (!undatedDeliveriesChecked) {
        await dateAllUndatedDeliveries(lease.pool, signal);
        undatedDeliveriesChecked = true;
      }
      return result;
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
  const attempts = await readExpiredLeases(pool, limit);
  const recovered: StalledWorkRecovery[] = await settleDeliveries(pool, signal);
  const failedRunJobs = await readFailedRunJobs(pool, limit);
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
  return Object.freeze({
    recovered: Object.freeze(recovered),
    failed: Object.freeze(failed),
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
