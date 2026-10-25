import { resumeOutcome, cancellationOutcome } from '@pertexo/workflow-engine';
import { and, asc, eq, exists, isNull, lte, or, sql } from 'drizzle-orm';
import {
  nodeRuns,
  runCheckpoints,
  workflowRuns,
} from '../../schema/runs/execution.js';
import { requestWorkflowRunCancellation } from '../../runs/commands/cancel.repository.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import type { OperatorDecision } from './contract.js';
import { withoutNulls, enqueueAdvance } from './enqueue.js';

/**
 * Wakes a run's due node retries and resumes, one page at a time, and its
 * due workflow wait, then asks the run to advance.
 */
export async function resumeDueWork(
  transaction: WorkspaceTransaction,
  input: Readonly<{ runId: string; dryRun: boolean }>,
): Promise<OperatorDecision> {
  const { runId } = input;
  const [run] = await transaction.db
    .select({ status: workflowRuns.status })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, runId),
      ),
    )
    .for('update');
  if (run === undefined)
    return {
      outcome: 'not_found',
      result: {
        dueNodeCount: 0,
        dueWorkflowWait: false,
        outcome: 'not_found',
      },
    };
  const db = transaction.db;
  const dueNodes = db
    .select({ id: nodeRuns.id })
    .from(nodeRuns)
    .where(nodeIsDue(transaction.workspaceId, runId))
    .limit(RESUME_PAGE + 1)
    .as('due');
  const dueNodeCountQuery = db
    .select({ count: sql<number>`count(*)::integer` })
    .from(dueNodes);
  const dueWaitQuery = db
    .select({ one: sql`1` })
    .from(runCheckpoints)
    .where(checkpointIsDue(transaction.workspaceId, runId));
  const [state] = await db
    .select({
      dueNodes: sql<number>`(${dueNodeCountQuery})`,
      dueWait: sql<boolean>`${exists(dueWaitQuery)}`,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, runId),
      ),
    );
  if (state === undefined) throw new Error('Locked run disappeared');
  const dueNodeCount = Math.min(state.dueNodes, RESUME_PAGE);
  const outcome = resumeOutcome(run.status, {
    dueNodeCount,
    dueWait: state.dueWait,
    dryRun: input.dryRun,
  });

  let outboxEventId: string | undefined;
  if (outcome === 'resumed') {
    const due = db.$with('due').as(
      db
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(nodeIsDue(transaction.workspaceId, runId))
        .orderBy(
          asc(sql`coalesce(${nodeRuns.retryDueAt},${nodeRuns.resumeAt})`),
          asc(nodeRuns.id),
        )
        .limit(RESUME_PAGE)
        .for('update'),
    );
    await db
      .with(due)
      .update(nodeRuns)
      .set({
        dueWakeupAt: sql`coalesce(${nodeRuns.retryDueAt},${nodeRuns.resumeAt})`,
        updatedAt: sql`clock_timestamp()`,
      })
      .from(due)
      .where(
        and(
          eq(nodeRuns.workspaceId, transaction.workspaceId),
          eq(nodeRuns.id, due.id),
        ),
      );
    await db
      .update(runCheckpoints)
      .set({
        resumeAt: null,
        resumeLeaseOwner: null,
        resumeLeaseToken: null,
        resumeLeaseExpiresAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(checkpointIsDue(transaction.workspaceId, runId));
    outboxEventId = await enqueueAdvance(transaction, runId);
  }
  return {
    outcome,
    result: withoutNulls({
      dueNodeCount,
      dueNodesRemaining: state.dueNodes > RESUME_PAGE,
      dueWorkflowWait: state.dueWait,
      outboxEventId,
      outcome,
    }),
  };
}

/** Requests cancellation through the same path the API uses. */
export async function cancelRun(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    runId: string;
    actorRef: string;
    reason: string;
    dryRun: boolean;
  }>,
): Promise<OperatorDecision> {
  const [run] = await transaction.db
    .select({
      status: workflowRuns.status,
      cancelRequested: sql<boolean>`${workflowRuns.cancelRequestedAt} is not null`,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, input.runId),
      ),
    )
    .for('update');
  const outcome = cancellationOutcome(run, input);

  let eventSequence: number | null = null;
  let outboxEventId: string | undefined;
  if (outcome === 'cancel_requested') {
    ({ eventSequence } = await requestWorkflowRunCancellation(transaction, {
      actor: input.actorRef,
      reason: input.reason,
      runId: input.runId,
    }));
    outboxEventId = await enqueueAdvance(transaction, input.runId);
  }
  return {
    outcome,
    result: withoutNulls({
      eventSequence,
      outboxEventId,
      outcome,
    }),
  };
}

function nodeIsDue(workspaceId: string, runId: string) {
  return and(
    eq(nodeRuns.workspaceId, workspaceId),
    eq(nodeRuns.workflowRunId, runId),
    eq(nodeRuns.status, 'waiting'),
    sql`coalesce(${nodeRuns.retryDueAt},${nodeRuns.resumeAt})<=clock_timestamp()`,
    sql`${nodeRuns.dueWakeupAt} is distinct from coalesce(${nodeRuns.retryDueAt},${nodeRuns.resumeAt})`,
  );
}
function checkpointIsDue(workspaceId: string, runId: string) {
  return and(
    eq(runCheckpoints.workspaceId, workspaceId),
    eq(runCheckpoints.workflowRunId, runId),
    lte(runCheckpoints.resumeAt, sql`clock_timestamp()`),
    or(
      isNull(runCheckpoints.resumeLeaseExpiresAt),
      lte(runCheckpoints.resumeLeaseExpiresAt, sql`clock_timestamp()`),
    ),
  );
}

/** Due nodes one resume marks; the result says when more remain. */
const RESUME_PAGE = 100;
