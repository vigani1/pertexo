import { attemptReconciliationOutcome } from './attempt-reconciliation.js';
import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { nodeAttempts, nodeRuns, workflowRuns } from '@pertexo/database/schema';
import {
  appendLockedRunEvent,
  RUN_EVENT_TYPE,
} from '../runs/queries/history/events.repository.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { enqueue } from '../outbox/enqueue-delivery.repository.js';
import { enqueueAdvance } from '../runs/wakeups/advance.repository.js';

/** Where a settlement came from, kept on the attempt and in its event. */
export type AttemptSettlementSource =
  | Readonly<{ operatorCommandId: string }>
  | Readonly<{ stalledWorkRecovery: true }>;

/**
 * Settles a running attempt whose lease expired: either back to ready for
 * another worker (never once an unsafe side effect may have been dispatched)
 * or to an unknown outcome the run then advances past. The operator command
 * and the stalled-work scanner both settle here, under the run lock.
 */
export async function settleExpiredAttempt(
  transaction: WorkspaceTransaction,
  attempt: LockedAttempt | undefined,
  input: Readonly<{
    attemptId: string;
    expectedFenceToken: number;
    action: 'reclaim' | 'outcome_unknown';
    dryRun: boolean;
    source: AttemptSettlementSource;
  }>,
): Promise<Readonly<{ outcome: string; outboxEventId?: string }>> {
  const { attemptId, expectedFenceToken: fence } = input;
  const outcome = attemptReconciliationOutcome(attempt, input);

  let outboxEventId: string | undefined;
  if (attempt !== undefined && outcome === 'reclaimed') {
    await transaction.db
      .update(nodeAttempts)
      .set({
        status: 'ready',
        fenceToken: fence + 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(nodeAttempts.workspaceId, transaction.workspaceId),
          eq(nodeAttempts.id, attemptId),
        ),
      );
    const node = await transaction.db
      .update(nodeRuns)
      .set({ status: 'ready', updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(nodeRuns.workspaceId, transaction.workspaceId),
          eq(nodeRuns.id, attempt.nodeRunId),
          eq(nodeRuns.currentAttemptId, attemptId),
          eq(nodeRuns.status, 'running'),
        ),
      )
      .returning({ id: nodeRuns.id });
    if (node.length !== 1)
      throw new Error('Reclaimed attempt does not own a running node');
    outboxEventId = await enqueue(transaction, {
      jobName: 'execute-node-attempt',
      aggregateType: 'node-attempt',
      aggregateId: attemptId,
      fields: {
        attemptId,
        nodeRunId: attempt.nodeRunId,
        runId: attempt.runId,
      },
    });
  } else if (attempt !== undefined && outcome === 'marked_unknown') {
    await transaction.db
      .update(nodeAttempts)
      .set({
        status: 'outcome_unknown',
        fenceToken: fence + 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        reconciliationRef: sql`${JSON.stringify(input.source)}::jsonb`,
        completedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(nodeAttempts.workspaceId, transaction.workspaceId),
          eq(nodeAttempts.id, attemptId),
        ),
      );
    await transaction.db
      .update(nodeRuns)
      .set({
        status: 'outcome_unknown',
        completedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(nodeRuns.workspaceId, transaction.workspaceId),
          eq(nodeRuns.id, attempt.nodeRunId),
          eq(nodeRuns.currentAttemptId, attemptId),
        ),
      );
    await appendLockedRunEvent(transaction, attempt.runId, {
      type: RUN_EVENT_TYPE.nodeOutcomeUnknown,
      payload: {
        attemptId,
        nodeRunId: attempt.nodeRunId,
        ...input.source,
        reconciliation: true,
      },
    });
    outboxEventId = await enqueueAdvance(transaction.db, {
      workspaceId: transaction.workspaceId,
      runId: attempt.runId,
    });
  }
  return outboxEventId === undefined
    ? Object.freeze({ outcome })
    : Object.freeze({ outcome, outboxEventId });
}

export type LockedAttempt = NonNullable<
  Awaited<ReturnType<typeof readLockedAttempt>>
>;

export async function readLockedAttempt(
  transaction: WorkspaceTransaction,
  attemptId: string,
) {
  const db = transaction.db;
  const attempt = alias(nodeAttempts, 'attempt'),
    node = alias(nodeRuns, 'node');
  const owner = db
    .select({ runId: node.workflowRunId })
    .from(attempt)
    .innerJoin(
      node,
      and(
        eq(node.workspaceId, attempt.workspaceId),
        eq(node.id, attempt.nodeRunId),
      ),
    )
    .where(
      and(
        eq(attempt.workspaceId, transaction.workspaceId),
        eq(attempt.id, attemptId),
      ),
    );
  // Every run writer locks the run before its attempt and node.
  await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, owner),
      ),
    )
    .for('update');
  const [row] = await db
    .select({
      status: attempt.status,
      fenceToken: attempt.fenceToken,
      dispatchMarkedAt: attempt.dispatchMarkedAt,
      sideEffectClass: attempt.sideEffectClass,
      nodeRunId: node.id,
      runId: node.workflowRunId,
      leaseExpired: sql<
        boolean | null
      >`${attempt.leaseExpiresAt}<=clock_timestamp()`,
    })
    .from(attempt)
    .innerJoin(
      node,
      and(
        eq(node.workspaceId, attempt.workspaceId),
        eq(node.id, attempt.nodeRunId),
      ),
    )
    .where(
      and(
        eq(attempt.workspaceId, transaction.workspaceId),
        eq(attempt.id, attemptId),
      ),
    )
    .for('update', { of: [attempt, node] });
  return row;
}
