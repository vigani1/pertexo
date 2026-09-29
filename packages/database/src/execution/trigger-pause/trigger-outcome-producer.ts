import type { PoolClient } from 'pg';

import { generatePersistedId } from '../../platform/persisted-id.js';
import type { ParsedTransitionPlan } from '../coordinator/coordinator-run-store-plan.js';

const countedTriggers: ReadonlySet<string> = new Set(['schedule', 'webhook']);
const failureStatuses: ReadonlySet<string> = new Set([
  'failed',
  'timed_out',
  'outcome_unknown',
]);

/**
 * Records the terminal outcome of a schedule- or webhook-started run for the
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
    plan: ParsedTransitionPlan;
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
  await client.query(
    `insert into app.workflow_trigger_outcomes (
       id,workspace_id,workflow_id,run_id,counts_as_failure,ended_at
     ) values ($1,$2,$3,$4,$5,$6::timestamptz)
     on conflict do nothing`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.workflowId,
      input.runId,
      failureStatuses.has(status),
      terminalEvent.occurredAt,
    ],
  );
}
