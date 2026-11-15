import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { workflowRuns, workflowCalls } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { wakeWorkflowRun } from '../../../outbox/run-advance.repository.js';
import { wakeTaskAncestors } from '../responses/task-responses.repository.js';

/** A paused or resumed clock changes what its ancestors and children may do. */
export async function wakeHumanWaitRelations(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<void> {
  await wakeTaskAncestors(client, workspaceId, runId);
  // The filter guarantees every accepted child identity is present.
  const children = await drizzle(client)
    .select({ id: sql<string>`${workflowCalls.childRunId}` })
    .from(workflowCalls)
    .where(
      and(
        eq(workflowCalls.workspaceId, workspaceId),
        eq(workflowCalls.parentRunId, runId),
        eq(workflowCalls.status, 'accepted'),
        isNotNull(workflowCalls.childRunId),
      ),
    )
    .catch(rethrowQueryFailure);
  for (const child of children)
    await wakeWorkflowRun(client, workspaceId, child.id);
}

/** The run's status and deadline clock, read after its lock. */
export function readRunClock(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; runId: string }>,
) {
  const r = workflowRuns;
  // The admission trigger pins an entitlement before an executable run can enter this phase.
  return drizzle(client)
    .select({
      status: r.status,
      cancel_requested_at: r.cancelRequestedAt,
      human_wait_started_at: r.humanWaitStartedAt,
      deadline_at: r.deadlineAt,
      absolute_deadline_at: r.absoluteDeadlineAt,
      execution_entitlement_version: sql<number>`${r.executionEntitlementVersion}`,
      deadline_expired: sql<boolean>`${r.deadlineAt} is not null and ${r.deadlineAt}<=clock_timestamp()`,
    })
    .from(r)
    .where(and(eq(r.workspaceId, input.workspaceId), eq(r.id, input.runId)))
    .catch(rethrowQueryFailure);
}
