import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import {
  nodeAttempts,
  nodeRuns,
  workflowTriggerOutcomes,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

import { generatePersistedId } from '@pertexo/database/platform';
import type { RunTransitionPlan } from '../../runs/advance/plan.js';
import { streakOutcome } from './outcome-rule.js';

/**
 * Records the terminal outcome of an externally triggered run for the
 * failure streak (ADR 056) in the transition's own transaction. It only
 * inserts, so concurrent runs of one workflow never contend; the worker folds
 * it into the workflow's streak.
 */
export async function persistWorkflowTriggerOutcome(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    workflowId: string;
    runId: string;
    triggerType: string;
    cancellationRequested: boolean;
    /** A step was on a timer or a person when time ran out: the workflow's own wait. */
    hadWaitingStep: boolean;
    plan: RunTransitionPlan;
  }>,
): Promise<void> {
  const status = input.plan.checkpoint.runStatus;
  const outcome = streakOutcome({
    triggerType: input.triggerType,
    cancellationRequested: input.cancellationRequested,
    status,
    waitedForCapacity:
      status === 'timed_out' &&
      !input.hadWaitingStep &&
      !(await hasAttemptInFlight(client, input)),
  });
  if (outcome === 'not_counted') return;
  const terminalEvent = input.plan.events.find(
    ({ name }) => name === `run.${status}`,
  );
  if (terminalEvent === undefined) return;
  await drizzle(client)
    .insert(workflowTriggerOutcomes)
    .values({
      id: generatePersistedId(),
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      runId: input.runId,
      countsAsFailure: outcome === 'failure',
      endedAt: terminalEvent.occurredAt,
    })
    .onConflictDoNothing()
    .catch(rethrowQueryFailure);
}

/** No worker had a step when time ran out, so nothing the workflow did took that time. */
async function hasAttemptInFlight(
  client: PoolClient,
  { workspaceId, runId }: Readonly<{ workspaceId: string; runId: string }>,
): Promise<boolean> {
  const inFlight = await drizzle(client)
    .select({ one: sql`1` })
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
        eq(nodeRuns.workspaceId, workspaceId),
        eq(nodeRuns.workflowRunId, runId),
        eq(nodeAttempts.status, 'running'),
      ),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  return inFlight.length > 0;
}
