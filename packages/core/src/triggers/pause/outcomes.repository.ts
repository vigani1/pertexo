import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowTriggerOutcomes } from '@pertexo/database/schema';
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
    plan: RunTransitionPlan;
  }>,
): Promise<void> {
  const status = input.plan.checkpoint.runStatus;
  const outcome = streakOutcome({
    triggerType: input.triggerType,
    cancellationRequested: input.cancellationRequested,
    status,
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
