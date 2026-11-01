import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { workspaceInboxEvents } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

import { generatePersistedId } from '@pertexo/database/platform';
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
  await drizzle(client)
    .insert(workspaceInboxEvents)
    .values({
      id: generatePersistedId(),
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      runId: input.runId,
      terminalEventSequence: BigInt(terminalEvent.sequence),
      kind: status,
      occurredAt: sql`${terminalEvent.occurredAt}::timestamptz`,
    })
    .onConflictDoNothing()
    .catch(rethrowQueryFailure);
}
