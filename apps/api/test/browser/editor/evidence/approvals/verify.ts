import type { Pool } from 'pg';
import { expect } from 'vitest';
export async function verifyApprovalEvidence(database: Pool) {
  const result = await database.query<{
    status: 'approved' | 'rejected';
    independent: boolean;
    allow_starter: boolean;
  }>(
    `select task.status,task.context,task.consumed_at is not null consumed,run.status run_status,task.decided_by<>run.started_by independent,task.output_ref,task.config->'allowStarterToDecide' allow_starter,run.human_wait_started_at from app.pending_run_tasks task join app.workflow_runs run on run.workspace_id=task.workspace_id and run.id=task.run_id where task.kind='approval' order by task.id`,
  );
  expect(result.rows).toHaveLength(3);
  expect(result.rows.map((row) => row.status).sort()).toEqual([
    'approved',
    'approved',
    'rejected',
  ]);
  for (const row of result.rows)
    expect(row).toMatchObject({
      consumed: true,
      run_status: 'succeeded',
      ...(row.independent ? {} : { allow_starter: true }),
      human_wait_started_at: null,
      context: {
        details: { Amount: 120, Customer: 'Captured customer', Ready: false },
      },
      output_ref: {
        kind: 'inline',
        value: {
          decision: row.status,
          comment: row.independent
            ? 'Reviewed in the browser'
            : 'Self-approved by configured starter',
          decidedByName: row.independent ? 'Approval viewer' : 'Approval owner',
        },
      },
    });
  expect(result.rows.filter((row) => row.independent)).toHaveLength(2);
  const attempts = await database.query(
    "select count(*)::int n from app.node_attempts attempt join app.pending_run_tasks task on task.node_run_id=attempt.node_run_id where task.kind='approval'",
  );
  expect(attempts.rows).toEqual([{ n: 3 }]);
  const audits = await database.query(
    "select metadata from app.audit_events where action='pending_task.decided'",
  );
  expect(audits.rows).toHaveLength(3);
  expect(JSON.stringify(audits.rows)).not.toContain('Reviewed in the browser');
  expect(JSON.stringify(audits.rows)).not.toContain('Captured customer');
}
