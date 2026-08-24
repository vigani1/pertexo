import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0033_durable_wait.sql',
  import.meta.url,
);

describe('durable Wait migration', () => {
  it('pins semantic delay and immutable attempt admission kinds', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain("wait_kind IN ('node_wait', 'retry_backoff')");
    expect(sql).toContain(
      "admission_kind IN ('execute', 'retry', 'wait_resume')",
    );
    expect(sql).toContain(
      "admission_kind varchar(32) NOT NULL DEFAULT 'execute'",
    );
    expect(sql).toContain('resume_at IS NOT NULL AND retry_due_at IS NULL');
    expect(sql).toContain('resume_at IS NULL AND retry_due_at IS NOT NULL');
  });

  it('claims due deadlines transactionally without broad worker grants', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('claim_due_workflow_run_deadlines');
    expect(sql).toMatch(/FOR UPDATE[\s\S]*SKIP LOCKED/iu);
    expect(sql).toContain("'advance-workflow-run'");
    expect(sql).toContain('deadline_wakeup_at = due.deadline_at');
    expect(sql).toContain('sha256');
    expect(sql).toContain(
      'GRANT UPDATE (deadline_wakeup_at) ON app.workflow_runs TO {{worker_runtime_role}}',
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE)\s+ON\s+app\.workflow_runs\s+TO\s+\{\{worker_runtime_role\}\}/iu,
    );
  });
});
