import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('operator execution recovery migration', () => {
  it('keeps shared execution authority private and grants only narrow wrappers', async () => {
    const migration = await readFile(
      new URL(
        '../migrations/0063_operator_execution_recovery.sql',
        import.meta.url,
      ),
      'utf8',
    );
    expect(migration).toContain(
      'CREATE FUNCTION app.execute_operator_execution_command(',
    );
    expect(migration).toContain(
      ') FROM PUBLIC,{{operator_role}},{{api_runtime_role}},{{worker_runtime_role}}',
    );
    expect(migration).toContain('app.reconcile_operator_attempt(');
    expect(migration).toContain('app.resume_operator_due_work(');
    expect(migration).toContain(
      'app.record_operator_unknown_outcome_evidence(',
    );
    expect(migration).toContain('app.cancel_operator_run(');
    expect(migration).toContain("'reconcile-unknown-outcome'");
    expect(migration).toContain('LIMIT 101');
    expect(migration).toContain('LIMIT 100');
    expect(migration).toContain('CREATE INDEX node_runs_operator_due_idx');
    expect(migration).toContain(
      'workspace_id,workflow_run_id,(coalesce(retry_due_at,resume_at)),id',
    );
    expect(migration).toContain('v_attempt.lease_expires_at IS NULL');
    expect(migration).toContain('ON DELETE CASCADE');
    expect(migration).not.toContain('node_attempts_operator_owner_select');
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]*\{\{operator_role\}\}/u,
    );
  });
});
