import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

const migrationUrl = new URL(
  '../migrations/0068_restore_artifact_inventory.sql',
  import.meta.url,
);

describe('restore artifact inventory migration', () => {
  it('exposes only a bounded finalized-artifact inventory to maintenance', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0076_replay_lineage_retention.sql');
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain(
      'CREATE FUNCTION app.enumerate_committed_tenant_artifacts(',
    );
    expect(migration).toContain("artifact.status='available'");
    expect(migration).toContain('artifact.finalized_at IS NOT NULL');
    expect(migration).toContain('ORDER BY artifact.workspace_id,artifact.id');
    expect(migration).toContain('LIMIT p_limit');
    expect(migration).toContain('TO {{maintenance_role}}');
    expect(migration).not.toMatch(/GRANT\s+SELECT\s+ON\s+app\.artifacts/iu);
  });
});
