import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { workflowRuns, workflowCalls } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { pauseHumanWait, resumeHumanWait } from './clock.repository.js';
import { readHumanWaitFacts } from './human-wait.queries.js';
import type { PoolClient } from 'pg';
import {
  wakeWorkflowRun,
  deferWorkflowRun,
} from '../../calls/wakeup.repository.js';
import { wakeTaskAncestors } from '../responses/respond.repository.js';

export type HumanWaitState = Readonly<{
  human_wait_started_at: Date | null;
  deadline_at: Date | null;
  deadline_expired: boolean;
  human_resume_deferred: boolean;
}>;
type RunClock = Awaited<ReturnType<typeof readRunClock>>[number];

async function wakeRelations(
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
/** Only the caller's run/checkpoint are locked. Ancestor/child state is observed. */
export async function synchronizeHumanWait(
  client: PoolClient,
  workspaceId: string,
  {
    runId,
    phase,
    alreadyDeferred = false,
  }: Readonly<{
    runId: string;
    phase: 'loading' | 'committed';
    alreadyDeferred?: boolean | undefined;
  }>,
): Promise<HumanWaitState> {
  const [run] = await readRunClock(client, { workspaceId, runId });
  if (run === undefined) throw new Error('Human wait run is unavailable');
  const unchanged = {
    human_wait_started_at: run.human_wait_started_at,
    deadline_at: run.deadline_at,
    deadline_expired: run.deadline_expired,
    human_resume_deferred: alreadyDeferred,
  };
  const runUnavailable =
    !['running', 'waiting'].includes(run.status) ||
    run.cancel_requested_at !== null ||
    run.deadline_expired;
  if (runUnavailable) return unchanged;
  const facts = await readHumanWaitFacts(client, { workspaceId, runId });
  if (facts === undefined) throw new Error('Human wait state is unavailable');
  // Completed Calls remain runnable work until their parent consumes the result.
  // A parent cannot execute ready siblings while its slot is lent. Keep its
  // clock paused until the human-blocked child can resume, as with a lone Call.
  const quiescent =
    (facts.all_human_waiting && facts.has_human_wait && !facts.resume_work) ||
    (facts.lent_human_wait &&
      !facts.has_running_or_timed_work &&
      !facts.child_resume_work);
  if (run.human_wait_started_at === null) {
    if (!quiescent || run.status !== 'waiting') return unchanged;
    await pauseHumanWait(client, { workspaceId, runId });
    await wakeRelations(client, workspaceId, runId);
  } else if (!quiescent) {
    const available = await humanWaitCapacityAvailable(client, workspaceId, {
      runId,
      run,
      ancestorWaiting: facts.ancestor_waiting,
    });
    if (!available) {
      if (!alreadyDeferred) await deferWorkflowRun(client, workspaceId, runId);
      return { ...unchanged, human_resume_deferred: true };
    }
    await resumeHumanWait(client, { workspaceId, runId });
    await wakeRelations(client, workspaceId, runId);
    if (phase === 'committed')
      await wakeWorkflowRun(client, workspaceId, runId);
  } else return unchanged;
  const [row] = await readRunClock(client, { workspaceId, runId });
  if (row === undefined) throw new Error('Human wait clock is unavailable');
  return {
    human_wait_started_at: row.human_wait_started_at,
    deadline_at: row.deadline_at,
    deadline_expired: row.deadline_expired,
    human_resume_deferred: alreadyDeferred,
  };
}

async function humanWaitCapacityAvailable(
  client: PoolClient,
  workspaceId: string,
  {
    runId,
    run,
    ancestorWaiting,
  }: Readonly<{ runId: string; run: RunClock; ancestorWaiting: boolean }>,
): Promise<boolean> {
  let available = false;
  if (!ancestorWaiting) {
    const capacity = await drizzle(client)
      .execute<{ available: boolean }>(
        sql`select app.workflow_run_active_capacity_available(${workspaceId},${run.execution_entitlement_version},${runId}) available`,
      )
      .catch(rethrowQueryFailure);
    available = capacity.rows[0]?.available ?? false;
  }

  return available;
}

function readRunClock(
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
