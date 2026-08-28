import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';

const migrationUrl = new URL(
  '../migrations/0058_workspace_object_versions_purge.sql',
  import.meta.url,
);

describe('workspace object-version purge migration', () => {
  it('orders one fenced object step before tenant rows', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe(
      '0067_reconcile_published_migration_repairs.sql',
    );
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain(
      "step_name IN ('object_versions','tenant_rows')",
    );
    expect(migration).toContain(
      "CASE step.step_name WHEN 'object_versions' THEN 0 ELSE 1 END",
    );
    expect(migration).toContain('LIMIT 1 FOR UPDATE');
    expect(migration).toContain('p_deleted_count NOT BETWEEN 1 AND 500');
    expect(migration).toContain('workspace object purge high water changed');
    expect(migration).toContain(
      'active workspace legal hold blocks object purge checkpoint',
    );
    expect(migration).toMatch(
      /step_name='object_versions'[\s\S]*step\.status='completed'/u,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.checkpoint_workspace_object_versions_page[\s\S]*TO \{\{maintenance_role\}\}/u,
    );
    expect(migration).not.toMatch(
      /GRANT[\s\S]*TO \{\{(?:api_runtime_role|lifecycle_command_role)\}\}/u,
    );
    expect(migration).not.toContain("'deletion_completed'");
  });
});
