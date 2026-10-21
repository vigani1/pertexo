import type { Pool } from 'pg';
import { expect } from 'vitest';
export async function verifyCallbackEvidence(database: Pool) {
  const tasks = await database.query(
    "select task.status,task.consumed_at is not null consumed,task.decided_by,task.output_ref,run.trigger_type,run.status run_status,run.human_wait_started_at from app.pending_run_tasks task join app.workflow_runs run on run.id=task.run_id and run.workspace_id=task.workspace_id where task.kind='callback'",
  );
  expect(tasks.rows).toMatchObject([
    {
      status: 'submitted',
      consumed: true,
      decided_by: null,
      output_ref: {
        kind: 'inline',
        value: {
          body: { completed: 'callback-browser-proof' },
          headers: { 'content-type': 'application/json' },
        },
      },
      trigger_type: 'test',
      run_status: 'succeeded',
      human_wait_started_at: null,
    },
  ]);
}
