import type { Pool } from 'pg';
import { expect } from 'vitest';
export async function verifySuiteEvidence(database: Pool) {
  const suite = await database.query<{
    id: string;
    snapshot_id: string;
    status: string;
  }>(
    "select suite.id,suite.snapshot_id,suite.status from app.workflow_test_suites suite join app.workflows workflow on workflow.id=suite.workflow_id where workflow.name='Suite qualification'",
  );
  expect(suite.rows).toHaveLength(1);
  const one = suite.rows[0];
  if (one === undefined) throw new Error('Suite evidence missing');
  expect(one.status).toBe('failed');
  const runs = await database.query<{
    id: string;
    workflow_version_id: string;
    trigger_type: string;
    status: string;
    created_at: Date;
    completed_at: Date;
  }>(
    'select run.id,run.workflow_version_id,run.trigger_type,run.status,run.created_at,run.completed_at from app.workflow_test_suite_cases entry join app.workflow_runs run on run.id=entry.run_id where entry.suite_id=$1 order by entry.ordinal',
    [one.id],
  );
  expect(runs.rows).toHaveLength(50);
  for (const run of runs.rows)
    expect(run).toMatchObject({
      workflow_version_id: one.snapshot_id,
      trigger_type: 'test',
      status: 'succeeded',
    });
  expect(runs.rows[0]?.completed_at.getTime()).toBeLessThanOrEqual(
    runs.rows[1]?.created_at.getTime() ?? 0,
  );
  const reports = await database.query<{ status: string; report: string }>(
    'select status,report from app.workflow_test_suite_cases where suite_id=$1 order by ordinal',
    [one.id],
  );
  expect(reports.rows.map((row) => row.status)).toEqual([
    'passed',
    'failed',
    ...Array.from({ length: 48 }, () => 'passed'),
  ]);
  expect(JSON.parse(reports.rows[1]?.report ?? 'null')).toMatchObject({
    assertions: [{ actual: { value: 8, matched: false } }],
  });
  const ids = runs.rows.map((run) => run.id);
  expect(new Set(runs.rows.map((run) => run.workflow_version_id)).size).toBe(1);
  for (let index = 1; index < runs.rows.length; index++)
    expect(runs.rows[index - 1]?.completed_at.getTime()).toBeLessThanOrEqual(
      runs.rows[index]?.created_at.getTime() ?? 0,
    );
  expect(
    (
      await database.query(
        'select source_run_id from app.run_error_workflow_intents where source_run_id=any($1::uuid[]) union all select workflow_run_id from app.run_failure_notification_intents where workflow_run_id=any($1::uuid[]) union all select run_id from app.workspace_inbox_events where run_id=any($1::uuid[]) union all select run_id from app.workflow_trigger_outcomes where run_id=any($1::uuid[]) union all select run_id from app.pending_run_tasks where run_id=any($1::uuid[]) union all select run_id from app.webhook_run_responses where run_id=any($1::uuid[])',
        [ids],
      )
    ).rows,
  ).toEqual([]);
}
