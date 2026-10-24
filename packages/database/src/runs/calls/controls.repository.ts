import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { databaseSchema } from '../../schema.js';
import { parseWorkspaceId } from '../../tenant-access/transactions.js';
import { requestWorkflowRunCancellation } from '../commands/cancel.repository.js';
import { terminalRunStatuses } from '../advance/plan.js';
import { wakeWorkflowRun } from './wakeup.repository.js';

/** A child consumes its direct parent's intent under its own run lock only. */
export async function applyIncomingCallCancellation(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  traceparent?: string,
): Promise<boolean> {
  const incoming = await client.query<{ id: string }>(
    `select id from app.workflow_calls where workspace_id=$1 and child_run_id=$2
       and cancel_requested_at is not null and cancel_applied_at is null`,
    [workspaceId, runId],
  );
  const call = incoming.rows[0];
  if (call === undefined) return false;
  const run = await client.query<{
    status: string;
    cancel_requested_at: Date | null;
  }>(
    'select status,cancel_requested_at from app.workflow_runs where workspace_id=$1 and id=$2 for no key update',
    [workspaceId, runId],
  );
  const row = run.rows[0];
  if (row === undefined) return false;
  if (
    !terminalRunStatuses.has(row.status) &&
    row.cancel_requested_at === null
  ) {
    await requestWorkflowRunCancellation(
      {
        db: drizzle(client, { schema: databaseSchema }),
        workspaceId: parseWorkspaceId(workspaceId),
      },
      { runId, actor: `workflow-call:${call.id}`, reason: 'parent_closed' },
    );
    await wakeWorkflowRun(client, workspaceId, runId, traceparent);
  }
  await client.query(
    'update app.workflow_calls set cancel_applied_at=clock_timestamp() where workspace_id=$1 and id=$2 and cancel_applied_at is null',
    [workspaceId, call.id],
  );
  return true;
}
