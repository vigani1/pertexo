import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';

const migrationUrl = new URL(
  '../migrations/0038_execution_admission.sql',
  import.meta.url,
);

describe('execution admission migration contract', () => {
  it('owns immutable entitlement history, reconciled slots, and durable fairness', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0038_execution_admission.sql');
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain(
      'workspace_execution_entitlement_versions_immutable',
    );
    expect(migration).toContain('workflow_runs_execution_admission');
    expect(migration).toContain('workflow_runs_refresh_execution_admission');
    expect(migration).toContain('workspace.queued_run_limit_exceeded');
    expect(migration).toContain('workspace.active_run_limit_exceeded');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('outbox_fair_dispatch_cursor');
    expect(migration).toContain('workflow_run_active_capacity_available');
    expect(migration).toContain("VALUES (NEW.id,1,'active',5,100");
  });
});
