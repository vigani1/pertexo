import { drizzle } from 'drizzle-orm/node-postgres';
import { activeCapacityAvailable } from '../../admission-locks.repository.js';
import { pauseHumanWait, resumeHumanWait } from './clock.repository.js';
import { readHumanWaitFacts } from './human-wait-facts.repository.js';
import type { PoolClient } from 'pg';
import {
  wakeWorkflowRun,
  deferWorkflowRun,
} from '../../../outbox/run-advance.repository.js';
import {
  readRunClock,
  wakeHumanWaitRelations,
} from './run-clock.repository.js';
import {
  humanWaitClockRunning,
  humanWaitQuiescent,
} from './human-wait-state.js';

export type HumanWaitState = Readonly<{
  human_wait_started_at: Date | null;
  deadline_at: Date | null;
  deadline_expired: boolean;
  human_resume_deferred: boolean;
}>;
type RunClock = Awaited<ReturnType<typeof readRunClock>>[number];

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
  if (!humanWaitClockRunning(run)) return unchanged;
  const facts = await readHumanWaitFacts(client, { workspaceId, runId });
  if (facts === undefined) throw new Error('Human wait state is unavailable');
  const quiescent = humanWaitQuiescent(facts);
  if (run.human_wait_started_at === null) {
    if (!quiescent || run.status !== 'waiting') return unchanged;
    await pauseHumanWait(client, { workspaceId, runId });
    await wakeHumanWaitRelations(client, workspaceId, runId);
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
    await wakeHumanWaitRelations(client, workspaceId, runId);
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
  if (ancestorWaiting) return false;
  return activeCapacityAvailable(drizzle(client), {
    workspaceId,
    entitlementVersion: run.execution_entitlement_version,
    runId,
  });
}
