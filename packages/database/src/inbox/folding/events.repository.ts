import type { PoolClient } from 'pg';

import { generatePersistedId } from '../../platform/persisted-id.js';
import type { RunTransitionPlan } from '../../runs/advance/plan.js';

const inboxKinds: ReadonlySet<string> = new Set([
  'failed',
  'timed_out',
  'outcome_unknown',
]);

/**
 * Records a run's terminal failure for the workspace inbox (ADR 055) in the
 * transition's own transaction. It only inserts, so concurrent failures of one
 * workflow never contend; the worker folds it into the workflow's thread.
 * A canceled run is not a failure notice.
 */
export async function persistWorkspaceInboxEvent(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    workflowId: string;
    runId: string;
    cancellationRequested: boolean;
    plan: RunTransitionPlan;
  }>,
): Promise<void> {
  const status = input.plan.checkpoint.runStatus;
  if (input.cancellationRequested || !inboxKinds.has(status)) return;
  const terminalEvent = input.plan.events.find(
    ({ name }) => name === `run.${status}`,
  );
  if (terminalEvent === undefined) return;
  await client.query(
    `insert into app.workspace_inbox_events (
       id,workspace_id,workflow_id,run_id,terminal_event_sequence,kind,occurred_at
     ) values ($1,$2,$3,$4,$5,$6,$7::timestamptz)
     on conflict do nothing`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.workflowId,
      input.runId,
      terminalEvent.sequence,
      status,
      terminalEvent.occurredAt,
    ],
  );
}
