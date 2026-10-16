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
  const audits = await database.query('select metadata from app.audit_events');
  expect(JSON.stringify(audits.rows)).not.toContain('private Code log');
  expect(JSON.stringify(audits.rows)).not.toContain('private Code failure');
}
