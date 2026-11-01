import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { WorkflowCheckpoint } from '@pertexo/workflow-engine';
import type { PoolClient } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workflowCalls, workflowRuns } from '@pertexo/database/schema';
import { deferWorkflowRun } from '../calls/wakeup.repository.js';
import { readHumanWaitFacts } from '../pending-tasks/lifecycle/human-wait.queries.js';

type RunScope = Readonly<{ workspaceId: string; runId: string }>;

/**
 * A run with nothing to do until a timer fires gives its workspace slot back, so
 * a long Wait doesn't stop other runs. Its deadline keeps counting and it keeps its
 * place in the workflow's own limit, which is what set this apart from a human wait.
 * A run in a call stays out: a parent and child share one lent slot.
 */
export async function releaseSlotDuringTimedWait(
  client: PoolClient,
  scope: RunScope,
  {
    checkpoint,
    row,
  }: Readonly<{
    checkpoint: Pick<WorkflowCheckpoint, 'runStatus' | 'invocations'>;
    row: Readonly<{ timed_wait_started_at: Date | null }>;
  }>,
): Promise<void> {
  // Read from the plan first: the full check is too costly for a run with no timer,
  // such as a large loop of Calls advancing many times.
  if (
    row.timed_wait_started_at !== null ||
    checkpoint.runStatus !== 'waiting' ||
    !checkpoint.invocations.some(
      ({ status, waitKind }) =>
        status === 'waiting' && waitKind === 'node_wait',
    )
  )
    return;
  const facts = await readHumanWaitFacts(client, scope);
  if (
    facts === undefined ||
    !facts.all_parked ||
    !facts.has_timed_wait ||
    facts.resume_work ||
    (await inWorkflowCall(client, scope))
  )
    return;
  const db = drizzle(client);
  await db
    .execute(
      sql`select app.lock_workspace_execution_counter(${scope.workspaceId})`,
    )
    .catch(rethrowQueryFailure);
  await db
    .update(workflowRuns)
    .set({
      timedWaitStartedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowRuns.workspaceId, scope.workspaceId),
        eq(workflowRuns.id, scope.runId),
        eq(workflowRuns.status, 'waiting'),
        isNull(workflowRuns.humanWaitStartedAt),
        isNull(workflowRuns.timedWaitStartedAt),
      ),
    )
    .catch(rethrowQueryFailure);
}

/**
 * Takes a slot back when the timer has fired, or defers if every slot is full, as a
 * human wait resuming does. Returns the row as it now stands.
 */
export async function reacquireSlotAfterTimedWait<
  Row extends Readonly<{
    timed_wait_started_at: Date | null;
    execution_entitlement_version: number;
  }>,
>(client: PoolClient, scope: RunScope, row: Row): Promise<Row> {
  if (row.timed_wait_started_at === null) return row;
  return (await slotTakenBack(client, scope, row.execution_entitlement_version))
    ? { ...row, timed_wait_started_at: null }
    : row;
}

async function slotTakenBack(
  client: PoolClient,
  scope: RunScope,
  entitlementVersion: number,
): Promise<boolean> {
  const facts = await readHumanWaitFacts(client, scope);
  if (facts === undefined || (!facts.timer_due && !facts.resume_work))
    return false;
  const db = drizzle(client);
  const capacity = await db
    .execute<{ available: boolean }>(
      sql`select app.workflow_run_active_capacity_available(${scope.workspaceId},${entitlementVersion},${scope.runId}) available`,
    )
    .catch(rethrowQueryFailure);
  if (capacity.rows[0]?.available !== true) {
    await deferWorkflowRun(client, scope.workspaceId, scope.runId);
    return false;
  }
  await db
    .update(workflowRuns)
    .set({ timedWaitStartedAt: null, updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(workflowRuns.workspaceId, scope.workspaceId),
        eq(workflowRuns.id, scope.runId),
      ),
    )
    .catch(rethrowQueryFailure);
  return true;
}

async function inWorkflowCall(
  client: PoolClient,
  { workspaceId, runId }: RunScope,
): Promise<boolean> {
  const calls = await drizzle(client)
    .select({ one: sql`1` })
    .from(workflowCalls)
    .where(
      and(
        eq(workflowCalls.workspaceId, workspaceId),
        or(
          eq(workflowCalls.parentRunId, runId),
          eq(workflowCalls.childRunId, runId),
        ),
      ),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  return calls.length > 0;
}
