import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0067_reconcile_published_migration_repairs.sql',
  import.meta.url,
);

describe('published migration repair', () => {
  it('converges every published 0037 and 0038 schema variant forward', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION app.lock_failure_notification_dispatch_destination(',
    );
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS app.workflow_run_active_admissions',
    );
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS app.workflow_run_active_capacity_available(uuid,integer)',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION app.reserve_workflow_run_active_admission(',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION app.recover_due_workflow_run_active_admissions(',
    );
    expect(migration).toContain('recovery_count TYPE bigint');
    expect(migration).toContain('CHECK(recovery_count>=0)');
  });
});
