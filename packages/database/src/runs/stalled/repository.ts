import {
  automaticReconciliationAction,
  overdueDeliveryAction,
} from '@pertexo/workflow-engine';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../../config.js';
import { nodeAttemptConsumerName } from '../../attempts/completion/receipts.repository.js';
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
import { inboxReceipts, outboxEvents } from '../../schema/transport.js';
import {
  withWorkspaceTransaction,
  type WorkspaceTransaction,
} from '../../tenant-access/transactions.js';
import { coordinatorConsumerName } from '../advance/receipts.repository.js';
import type {
  StalledWorkFailure,
  StalledWorkRecovery,
  StalledWorkStore,
} from './contract.js';

/** A busy run holds its lock only briefly; the next scan tries again. */
const LOCK_TIMEOUT_MILLIS = 5_000;
const STATEMENT_TIMEOUT_MILLIS = 15_000;

export function createStalledWorkStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): StalledWorkStore {
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  return Object.freeze({
    recoverDue: (limit: number, signal: AbortSignal) =>
      recoverDue(lease.pool, limit, signal),
    close: () => lease.close(),
  });
}

async function recoverDue(pool: Pool, limit: number, signal: AbortSignal) {
  const attempts = await readExpiredLeases(pool, limit);
  const deliveries = await readOverdueDeliveries(pool, limit);
  const recovered: StalledWorkRecovery[] = [];
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
  for (const delivery of deliveries)
    await settle(delivery.workspaceId, delivery.id, (transaction) =>
      recoverOverdueDelivery(transaction, delivery),
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

type OverdueDelivery = Readonly<{
  id: string;
  workspaceId: string;
  jobName: string;
  aggregateId: string;
}>;

/**
 * Takes a batch of due rows. Most are simply confirmed, and lose their due time
 * here in one statement, so the step path carries no extra write for this.
 */
async function readOverdueDeliveries(
  pool: Pool,
  limit: number,
): Promise<readonly OverdueDelivery[]> {
  const result = await drizzle(pool)
    .execute<OverdueDelivery>(
      sql`
      with due as materialized (
        select e.id, e.workspace_id, e.job_name, e.aggregate_id,
               exists(
                 select 1 from ${inboxReceipts} r
                  where r.consumer_name in (${coordinatorConsumerName},${nodeAttemptConsumerName})
                    and r.message_id = e.id and r.completed_at is not null
               ) as confirmed
          from ${outboxEvents} e
         where e.delivery_due_at <= clock_timestamp()
         order by e.delivery_due_at, e.id
         limit ${limit}
         for update of e skip locked
      ), cleared as (
        update ${outboxEvents} e set delivery_due_at = null, updated_at = clock_timestamp()
          from due where e.id = due.id and due.confirmed
        returning e.id
      )
      select due.id, due.workspace_id as "workspaceId", due.job_name as "jobName",
             due.aggregate_id as "aggregateId"
        from due where not due.confirmed`,
    )
    .catch(rethrowQueryFailure);
  return result.rows;
}

async function recoverOverdueDelivery(
  transaction: WorkspaceTransaction,
  delivery: OverdueDelivery,
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
  delivery: OverdueDelivery,
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
