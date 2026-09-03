import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

const migrationUrl = new URL(
  '../migrations/0038_execution_admission.sql',
  import.meta.url,
);
const workerAdmissionMigrationUrl = new URL(
  '../migrations/0042_worker_run_admission_lock.sql',
  import.meta.url,
);

describe('execution admission migration contract', () => {
  it('owns immutable entitlement history, reconciled slots, and durable fairness', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe(
      '0074_retention_schedule_state_rls.sql',
    );
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
    expect(migration).toContain('workflow_run_active_admissions');
    expect(migration).toContain('reserve_workflow_run_active_admission');
    expect(migration).toContain('workflow_run_active_admission_eligible');
    expect(migration).toContain(
      'release_dispatcher_workflow_run_active_admission',
    );
    expect(migration).toContain('recover_due_workflow_run_active_admissions');
    expect(migration).toContain("VALUES (NEW.id,1,'active',5,100");
  });

  it('gives worker acceptance a narrow workspace lifecycle lock', async () => {
    const migration = await readFile(workerAdmissionMigrationUrl, 'utf8');

    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('FOR SHARE');
    expect(migration).toContain('RETURNS varchar');
    expect(migration).toContain('lock_workflow_failure_notification_policy');
    expect(migration).toContain(
      'TO {{api_runtime_role}},{{worker_runtime_role}}',
    );
    expect(migration).toContain(
      'GRANT UPDATE(status,result_ref,updated_at) ON app.idempotency_records',
    );
    expect(migration).not.toContain('GRANT UPDATE ON app.workspaces');
    expect(migration).not.toContain(
      'GRANT UPDATE ON app.failure_notification_destinations',
    );
  });
});
