import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

const migrationUrl = new URL(
  '../migrations/0056_workspace_purge_foundation.sql',
  import.meta.url,
);

describe('workspace purge foundation migration', () => {
  it('keeps purge fenced, maintenance-only, and incomplete', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0076_replay_lineage_retention.sql');
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain('workspace_purge_jobs');
    expect(migration).toContain('workspace_purge_steps');
    expect(migration).toContain("step_name='tenant_rows'");
    expect(migration).toContain('workspace purge control high water changed');
    expect(migration).toContain('workspace_purge_repair_command_id');
    expect(migration).toContain("USING ERRCODE='55P03'");
    expect(migration).toContain('workspace purge is incomplete');
    expect(migration).toContain(
      'active workspace legal hold blocks destructive purge step',
    );
    expect(migration).toContain(
      'workspace purge destructive high water is not exact',
    );
    expect(migration).toContain("'purge_started'");
    expect(migration).not.toContain("'deletion_completed',");
    expect(migration).not.toMatch(/DELETE FROM app\./u);
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.find_due_workspace_purge\(\)[\s\S]*TO \{\{maintenance_role\}\}/u,
    );
    expect(migration).not.toMatch(
      /GRANT[\s\S]*TO \{\{(?:api_runtime_role|lifecycle_command_role)\}\}/u,
    );
  });
});
