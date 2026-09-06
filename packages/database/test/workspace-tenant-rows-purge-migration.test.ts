import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

const migrationUrl = new URL(
  '../migrations/0057_workspace_tenant_rows_purge.sql',
  import.meta.url,
);

describe('workspace tenant-row purge migration', () => {
  it('keeps pages bounded, fenced, hold-safe, and maintenance-only', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0077_replay_read_locks.sql');
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain('p_page_size NOT BETWEEN 1 AND 500');
    expect(migration).toContain(
      'workspace tenant-row purge high water changed',
    );
    expect(migration).toContain(
      'active workspace legal hold blocks tenant-row purge page',
    );
    expect(migration).toContain('hold.released_sequence IS NULL');
    expect(migration).toContain('workspace_purge_immutable_delete_is_armed');
    expect(migration).toContain('workspace_creation_idempotency_records');
    expect(migration).toContain('transport_security_audit_facts_minimized');
    expect(migration).toContain('workspace tenant-row purge has residual rows');
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.find_due_workspace_purge_step\(\),[\s\S]*TO \{\{maintenance_role\}\}/u,
    );
    expect(migration).not.toMatch(
      /GRANT[\s\S]*TO \{\{(?:api_runtime_role|lifecycle_command_role)\}\}/u,
    );
    expect(migration).not.toContain("'deletion_completed'");
  });
});
