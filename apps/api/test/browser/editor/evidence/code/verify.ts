import type { Pool } from 'pg';
import { expect } from 'vitest';

export async function verifyCodeEvidence(database: Pool) {
  const attempts = await database.query<{
    status: string;
    safe_error_code: string | null;
    error_summary: string | null;
    code_diagnostics: unknown;
  }>(
    `select attempt.status,attempt.safe_error_code,attempt.error_summary,attempt.code_diagnostics from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id join app.workflow_runs run on run.id=node.workflow_run_id join app.workflows workflow on workflow.id=run.workflow_id where workflow.name='Code qualification' order by attempt.created_at,attempt.id`,
  );
  expect(attempts.rows).toHaveLength(2);
  expect(attempts.rows[0]).toMatchObject({
    status: 'succeeded',
    code_diagnostics: {
      logs: [{ level: 'info', message: 'private Code log' }],
      truncated: false,
    },
  });
  expect(attempts.rows[1]).toMatchObject({
    status: 'failed',
    safe_error_code: 'code.runtime_error',
    error_summary: null,
    code_diagnostics: { error: { message: 'private Code failure', line: 2 } },
  });
  const values = await database.query(
    `select run.variable_set_revision, variable_set.values_json,node.output_ref from app.workflow_runs run join app.workspace_variable_set_revisions variable_set on variable_set.workspace_id=run.workspace_id and variable_set.revision=run.variable_set_revision join app.node_runs node on node.workflow_run_id=run.id join app.workflows workflow on workflow.id=run.workflow_id where workflow.name='Code qualification' and run.status='succeeded'`,
  );
  expect(values.rows).toEqual([
    {
      variable_set_revision: 1,
      values_json: { RATE: 4 },
      output_ref: {
        kind: 'inline',
        value: { total: 7, year: 2026, process: 'undefined' },
      },
    },
  ]);
  const pinned = await database.query(
    `select preview.output_ref,preview.pinned_sample_id,(select count(*)::int from app.preview_attempts attempt where attempt.preview_run_id=preview.id) as attempts from app.preview_runs preview join app.workflows workflow on workflow.id=preview.workflow_id where workflow.name='Code qualification' and preview.pinned_sample_id is not null`,
  );
  expect(pinned.rows).toEqual([
    {
      output_ref: { kind: 'inline', value: { total: 999 } },
      pinned_sample_id: expect.any(String) as unknown,
      attempts: 0,
    },
  ]);
  const audits = await database.query('select metadata from app.audit_events');
  expect(JSON.stringify(audits.rows)).not.toContain('private Code log');
  expect(JSON.stringify(audits.rows)).not.toContain('private Code failure');
}
