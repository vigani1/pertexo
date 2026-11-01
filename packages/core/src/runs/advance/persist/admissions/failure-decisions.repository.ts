import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { nodeRuns, nodeAttempts } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from '../../../state-errors.js';
import type { PendingCoordinatorFailure } from '../../load/state.queries.js';

import type { RunTransitionPlan } from '../../plan.js';

export async function persistPendingFailureDecisions(
  client: PoolClient,
  plan: RunTransitionPlan,
  {
    pendingFailures,
    workspaceId,
    runId,
  }: Readonly<{
    pendingFailures: readonly PendingCoordinatorFailure[];
    workspaceId: string;
    runId: string;
  }>,
): Promise<void> {
  const invocations = new Map(
    [...plan.checkpoint.invocations, ...(plan.prunedInvocations ?? [])].map(
      (invocation) => [invocation.invocationKey, invocation],
    ),
  );
  const decisionEvents = new Map(
    plan.events.flatMap((event) =>
      event.invocationKey !== undefined &&
      failureDecisions[event.name] !== undefined
        ? [[event.invocationKey, event] as const]
        : [],
    ),
  );
  for (const failure of pendingFailures) {
    const event = decisionEvents.get(failure.invocation_key);
    if (event === undefined || !invocations.has(failure.invocation_key))
      throw new CoordinatorRunStateCorruptError();
    const decision = failureDecision(event.name);
    const a = nodeAttempts;
    const finalized = await drizzle(client)
      .update(a)
      .set({ retryDecision: decision, updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(a.workspaceId, workspaceId),
          eq(a.id, failure.attempt_id),
          eq(a.retryDecision, 'pending'),
        ),
      )
      .catch(rethrowQueryFailure);
    if (finalized.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
    const nodeStatus = decision === 'retry' ? 'waiting' : decision;
    const n = nodeRuns;
    const updated = await drizzle(client)
      .update(n)
      .set({
        status: nodeStatus,
        retryDueAt:
          decision === 'retry'
            ? sql`${event.dueAt ?? null}::timestamptz`
            : null,
        resumeAt: null,
        waitKind: nodeStatus === 'waiting' ? 'retry_backoff' : null,
        dueWakeupAt: null,
        completedAt: nodeStatus === 'waiting' ? null : sql`clock_timestamp()`,
        safeErrorCode: failure.safe_error_code,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(n.workspaceId, workspaceId),
          eq(n.workflowRunId, runId),
          eq(n.invocationKey, failure.invocation_key),
          eq(n.currentAttemptId, failure.attempt_id),
          eq(n.status, 'running'),
        ),
      )
      .catch(rethrowQueryFailure);
    if (updated.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
}

const failureDecisions: Readonly<
  Partial<
    Record<
      RunTransitionPlan['events'][number]['name'],
      'retry' | typeof nodeRuns.$inferSelect.status
    >
  >
> = {
  'node.retry_scheduled': 'retry',
  'node.failed': 'failed',
  'node.canceled': 'canceled',
  'node.timed_out': 'timed_out',
  'node.outcome_unknown': 'outcome_unknown',
};
function failureDecision(name: RunTransitionPlan['events'][number]['name']) {
  const decision = failureDecisions[name];
  if (decision === undefined) throw new CoordinatorRunStateCorruptError();
  return decision;
}
