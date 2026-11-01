import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowTriggerOutcomes } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

import { generatePersistedId } from '@pertexo/database/platform';
import type { RunTransitionPlan } from '../../runs/advance/plan.js';

const countedTriggers: ReadonlySet<string> = new Set([
  'schedule',
  'webhook',
  'form',
]);
const failureStatuses: ReadonlySet<string> = new Set([
  'failed',
  'timed_out',
  'outcome_unknown',
]);

/**
 * Records the terminal outcome of an externally triggered run for the
 * failure streak (ADR 056) in the transition's own transaction. It only
 * inserts, so concurrent runs of one workflow never contend; the worker folds
 * it into the workflow's streak. A success resets the streak; a canceled run
 * and runs started manually, through the API or as replays are not recorded.
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
  if (input.cancellationRequested || !countedTriggers.has(input.triggerType))
    return;
  if (status !== 'succeeded' && !failureStatuses.has(status)) return;
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
      countsAsFailure: failureStatuses.has(status),
      endedAt: terminalEvent.occurredAt,
    })
    .onConflictDoNothing()
    .catch(rethrowQueryFailure);
}
