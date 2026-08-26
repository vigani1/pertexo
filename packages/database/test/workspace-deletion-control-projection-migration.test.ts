import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';

const migrationUrl = new URL(
  '../migrations/0046_workspace_deletion_control_projection.sql',
  import.meta.url,
);

describe('workspace deletion control projection migration contract', () => {
  it('adds only non-destructive, maintenance-owned lifecycle projection', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe(
      '0049_workspace_deletion_side_effects.sql',
    );
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain("'purging'");
    expect(migration).toContain('project_workspace_deletion');
    expect(migration).toContain('validate_workspace_deletion_command');
    expect(migration).toContain('enumerate_workspace_control_anchors');
    expect(migration).toContain("DEFAULT interval '30 days'");
    expect(migration).toContain('p_occurred_at>=v_workspace.purge_after');
    expect(migration).toContain(
      'p_occurred_at<v_workspace.deletion_requested_at',
    );
    expect(migration).toContain('deletion completion predates purge start');
    expect(migration).toContain('active workspace legal hold blocks');
    expect(migration).toContain('workspace deletion lifecycle event predates');
    expect(migration).toMatch(
      /arm_workspace_control_projection\(\)[\s\S]+SECURITY DEFINER[\s\S]+row_security=on/u,
    );
    expect(migration).toContain('AND legal_authority IS NULL');
    expect(migration).toContain(
      'workspace control anchors change only through control projection',
    );
    expect(migration).toContain('TO {{maintenance_role}}');
    expect(migration).not.toContain(
      'REVOKE UPDATE (status,deletion_requested_at',
    );
    expect(migration).not.toMatch(/DELETE\s+FROM\s+app\./iu);
    expect(migration).not.toContain('validate_workspace_purge');
  });
});
