import type { Pool } from 'pg';
import { expect } from 'vitest';

export async function verifyDraftTestEvidence(database: Pool) {
  const runs = await database.query<{
    id: string;
    status: string;
    trigger_type: string;
    retained_seconds: number;
  }>(
    `select run.id,run.status,run.trigger_type,extract(epoch from (run.input_ref_expires_at-run.created_at))::integer retained_seconds from app.workflow_runs run join app.workflows workflow on workflow.id=run.workflow_id where workflow.name='Draft test qualification' order by run.created_at,run.id`,
  );
  expect(runs.rows.map((run) => [run.trigger_type, run.status])).toEqual([
    ['test', 'failed'],
    ['test', 'succeeded'],
    ['test', 'succeeded'],
    ['manual', 'canceled'],
  ]);
  const testIds = runs.rows
    .filter((run) => run.trigger_type === 'test')
    .map((run) => run.id);
  expect(
    runs.rows
      .filter((run) => run.trigger_type === 'test')
      .map((run) => run.retained_seconds),
  ).toEqual([604800, 604800, 604800]);
  const snapshots = await database.query(
    'select id from app.workflow_test_snapshots where id=any($1::uuid[])',
    [testIds],
  );
  expect(snapshots.rows).toHaveLength(3);
  const suppressions = await database.query(
    `select source_run_id run_id from app.run_error_workflow_intents where source_run_id=any($1::uuid[])
 union all select workflow_run_id from app.run_failure_notification_intents where workflow_run_id=any($1::uuid[])
 union all select run_id from app.workspace_inbox_events where run_id=any($1::uuid[])
 union all select run_id from app.workflow_trigger_outcomes where run_id=any($1::uuid[])
 union all select run_id from app.pending_run_tasks where run_id=any($1::uuid[])
 union all select run_id from app.webhook_run_responses where run_id=any($1::uuid[])`,
    [testIds],
  );
  expect(suppressions.rows).toEqual([]);
  const code = await database.query<{
    workflow_run_id: string;
    output_ref: unknown;
    code_diagnostics: unknown;
    dispatch_marked_at: Date | null;
  }>(
    `select node.workflow_run_id,node.output_ref,attempt.code_diagnostics,attempt.dispatch_marked_at from app.node_runs node join app.node_attempts attempt on attempt.node_run_id=node.id join app.workflow_test_snapshots snapshot on snapshot.id=node.workflow_run_id join lateral jsonb_array_elements(snapshot.graph_json->'nodes') step on step->>'id'=node.node_id where node.workflow_run_id=any($1::uuid[]) and step#>>'{definition,key}'='core.code' order by node.created_at,node.id`,
    [testIds],
  );
  expect(code.rows).toHaveLength(3);
  expect(code.rows.map((row) => row.output_ref)).toEqual(
    Array.from({ length: 3 }, () => ({
      kind: 'inline',
      value: { amount: 42 },
    })),
  );
  expect(code.rows[0]?.code_diagnostics).toMatchObject({
    logs: [{ level: 'info', message: 'real draft-test Code execution' }],
  });
  expect(code.rows[1]?.code_diagnostics).toEqual(
    code.rows[0]?.code_diagnostics,
  );
  expect(code.rows[2]).toMatchObject({
    code_diagnostics: null,
    dispatch_marked_at: null,
  });
  const waits = await database.query(
    `select node.resume_at from app.node_runs node join app.workflow_test_snapshots snapshot on snapshot.id=node.workflow_run_id join lateral jsonb_array_elements(snapshot.graph_json->'nodes') step on step->>'id'=node.node_id where node.workflow_run_id=any($1::uuid[]) and step#>>'{definition,key}'='core.wait'`,
    [testIds],
  );
  expect(waits.rows).toEqual([
    { resume_at: null },
    { resume_at: null },
    { resume_at: null },
  ]);
}
