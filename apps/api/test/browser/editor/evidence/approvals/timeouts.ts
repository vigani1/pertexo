import type { Pool } from 'pg';
import { expect } from 'vitest';

/** One run continued on Timed out; one saved without the choice still failed. */
export async function verifyTaskTimeoutEvidence(database: Pool) {
  const tasks = await database.query<{ run_id: string }>(
    `select task.status,task.consumed_at is not null consumed,task.config->>'onExpiry' on_expiry,task.output_ref->'value'->>'timedOut' timed_out,run.status run_status,run.id run_id from app.pending_run_tasks task join app.workflow_runs run on run.workspace_id=task.workspace_id and run.id=task.run_id where task.kind='approval' order by run.created_at`,
  );
  expect(tasks.rows).toMatchObject([
    {
      status: 'expired',
      consumed: true,
      on_expiry: 'continue',
      timed_out: 'true',
      run_status: 'succeeded',
    },
    {
      // Saved without the choice, like every step before it existed.
      status: 'expired',
      consumed: true,
      on_expiry: null,
      timed_out: null,
      run_status: 'failed',
    },
  ]);
  const continued = await database.query(
    'select node_id,status from app.node_runs where workflow_run_id=$1 and node_id in ($2,$3,$4) order by node_id',
    [tasks.rows[0]?.run_id, 'approved', 'escalate', 'rejected'],
  );
  expect(continued.rows).toEqual([
    { node_id: 'approved', status: 'skipped' },
    { node_id: 'escalate', status: 'succeeded' },
    { node_id: 'rejected', status: 'skipped' },
  ]);
  const failed = await database.query(
    "select status,safe_error_code from app.node_runs where workflow_run_id=$1 and node_id='approval'",
    [tasks.rows[1]?.run_id],
  );
  expect(failed.rows).toEqual([
    { status: 'failed', safe_error_code: 'pending_task.expired' },
  ]);
}
