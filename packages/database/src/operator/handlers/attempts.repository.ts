import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  nodeAttempts,
  nodeRuns,
  workflowRuns,
} from '../../schema/runs/execution.js';

import {
  appendLockedRunEvent,
  RUN_EVENT_TYPE,
} from '../../runs/queries/history/events.repository.js';
import { operatorUnknownOutcomeEvidence } from '../../schema/runs/operator.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import type { OperatorDecision } from './contract.js';
import { withoutNulls, enqueue, enqueueAdvance } from './enqueue.js';

/**
 * Settles a running attempt whose lease expired: either back to ready for
 * another worker (never once an unsafe side effect may have been dispatched)
 * or to an unknown outcome the run then advances past.
 */
export async function reconcileAttempt(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    commandId: string;
    attemptId: string;
    expectedFenceToken: number;
    action: 'reclaim' | 'outcome_unknown';
    dryRun: boolean;
  }>,
): Promise<OperatorDecision> {
  const { attemptId, action, expectedFenceToken: fence } = input;
  const attempt = await readLockedAttempt(transaction, attemptId);
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
        reconciliationRef: sql`jsonb_build_object('operatorCommandId',${input.commandId}::uuid)`,
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
        operatorCommandId: input.commandId,
        reconciliation: true,
      },
    });
    outboxEventId = await enqueueAdvance(transaction, attempt.runId);
  }
  const changed = outcome === 'reclaimed' || outcome === 'marked_unknown';
  return {
    outcome,
    result: withoutNulls({
      action,
      fenceToken: changed ? fence + 1 : fence,
      outboxEventId,
      outcome,
    }),
  };
}

/** Records what an operator learned about an unknown outcome and asks a worker to reconcile it. */
export async function recordUnknownOutcomeEvidence(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    commandId: string;
    attemptId: string;
    evidenceKind: string;
    evidenceRef: string;
  }>,
): Promise<OperatorDecision> {
  const [attempt] = await transaction.db
    .select({ status: nodeAttempts.status })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.workspaceId, transaction.workspaceId),
        eq(nodeAttempts.id, input.attemptId),
      ),
    )
    .for('update');
  const status = attempt?.status;
  const outcome = evidenceOutcome(status);

  let outboxEventId: string | null = null;
  if (outcome === 'evidence_recorded') {
    await transaction.db.insert(operatorUnknownOutcomeEvidence).values({
      commandId: input.commandId,
      workspaceId: transaction.workspaceId,
      attemptId: input.attemptId,
      evidenceKind: input.evidenceKind,
      evidenceRef: sql`${input.evidenceRef}::jsonb`,
    });
    outboxEventId = await enqueue(transaction, {
      jobName: 'reconcile-unknown-outcome',
      aggregateType: 'node-attempt',
      aggregateId: input.attemptId,
      fields: {
        attemptId: input.attemptId,
        evidenceCommandId: input.commandId,
      },
    });
  }
  return {
    outcome,
    result: {
      evidenceKind: input.evidenceKind,
      outboxEventId,
      outcome,
    },
  };
}

function attemptReconciliationOutcome(
  attempt: Awaited<ReturnType<typeof readLockedAttempt>>,
  input: Readonly<{
    expectedFenceToken: number;
    action: 'reclaim' | 'outcome_unknown';
    dryRun: boolean;
  }>,
): string {
  if (attempt === undefined) return 'not_found';
  if (attempt.status !== 'running') return 'not_running';
  if (attempt.fenceToken !== input.expectedFenceToken) return 'fence_conflict';
  if (!(attempt.leaseExpired ?? false)) return 'lease_active';
  const unsafeReclaim =
    input.action === 'reclaim' &&
    attempt.dispatchMarkedAt !== null &&
    attempt.sideEffectClass === 'unsafe';
  if (unsafeReclaim) return 'reclaim_unsafe';
  if (input.dryRun)
    return input.action === 'reclaim' ? 'would_reclaim' : 'would_mark_unknown';
  return input.action === 'reclaim' ? 'reclaimed' : 'marked_unknown';
}
function evidenceOutcome(status: string | undefined): string {
  if (status === undefined) return 'not_found';
  if (status !== 'outcome_unknown') return 'not_unknown';
  return 'evidence_recorded';
}

async function readLockedAttempt(
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
