import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('workspace maintenance-rerun purge migration', () => {
  it('keeps bounded destructive authority while repairing dependency order', async () => {
    const migration = await readFile(
      new URL(
        '../migrations/0087_workspace_maintenance_rerun_purge.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION app.execute_workspace_tenant_rows_page(',
    );
    expect(migration).toContain('p_page_size NOT BETWEEN 1 AND 500');
    expect(migration).toContain('operator_maintenance_rerun_requests');
    expect(migration).toContain(
      'SET current_attempt_id=NULL,current_attempt_number=NULL',
    );
    expect(migration.indexOf("'preview_attempts'")).toBeLessThan(
      migration.indexOf("v_surface:='preview_runs'"),
    );
    expect(
      migration.indexOf('DELETE FROM app.connection_secret_versions'),
    ).toBeLessThan(migration.indexOf('DELETE FROM app.connections connection'));
    expect(
      migration.indexOf(
        'DELETE FROM app.failure_notification_destination_versions',
      ),
    ).toBeLessThan(
      migration.indexOf('DELETE FROM app.failure_notification_destinations'),
    );
    expect(migration).toContain('SET published_version_id=NULL');
    expect(migration).toContain(
      'workspace tenant-row purge has residual rows in %',
    );
    expect(migration).toContain(
      'active workspace legal hold blocks tenant-row purge page',
    );
    expect(migration).toContain(
      'workspace tenant-row purge high water changed',
    );
    expect(migration).toContain('SET row_security=on');
    expect(migration).toContain('TO {{maintenance_role}}');
    expect(migration).not.toMatch(
      /GRANT[\s\S]*TO \{\{(?:api_runtime_role|lifecycle_command_role)\}\}/u,
    );
  });
});
