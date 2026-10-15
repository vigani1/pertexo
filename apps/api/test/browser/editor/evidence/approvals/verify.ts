import type { Pool } from 'pg';
import { expect } from 'vitest';
export async function verifyApprovalEvidence(database: Pool) {
  const result = await database.query<{ status: 'approved' | 'rejected' }>(
    `select task.status,task.consumed_at is not null consumed,run.status run_status,task.decided_by<>run.started_by independent,task.output_ref,run.human_wait_started_at from app.pending_run_tasks task join app.workflow_runs run on run.workspace_id=task.workspace_id and run.id=task.run_id order by task.id`,
  );
  expect(result.rows).toHaveLength(2);
  expect(result.rows.map((row) => row.status).sort()).toEqual([
    'approved',
    'rejected',
  ]);
  for (const row of result.rows)
    expect(row).toMatchObject({
      consumed: true,
      run_status: 'succeeded',
      independent: true,
      human_wait_started_at: null,
      output_ref: {
        kind: 'inline',
        value: { decision: row.status, comment: 'Reviewed in the browser' },
      },
    });
  const attempts = await database.query(
    'select count(*)::int n from app.node_attempts attempt join app.pending_run_tasks task on task.node_run_id=attempt.node_run_id',
  );
  expect(attempts.rows).toEqual([{ n: 2 }]);
  const audits = await database.query(
    "select metadata from app.audit_events where action='pending_task.decided'",
  );
  expect(audits.rows).toHaveLength(2);
  expect(JSON.stringify(audits.rows)).not.toContain('Reviewed in the browser');
}
