import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

const migrationUrl = new URL(
  '../migrations/0075_workspace_purge_step_release.sql',
  import.meta.url,
);

describe('workspace purge step release migration', () => {
  it('adds a lease-fenced maintenance-only retry transition', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    expect(EXPECTED_MIGRATION_HEAD).toBe('0078_workflow_lifecycle_revision.sql');
    expect(migration).toContain(
      'CREATE FUNCTION app.release_workspace_purge_step',
    );
    expect(migration).toContain("status='running'");
    expect(migration).toContain('lease_token=p_lease_token');
    expect(migration).toContain('lease_fence=p_lease_fence');
    expect(migration).toContain('TO {{maintenance_role}}');
    expect(migration).toContain('FROM PUBLIC,{{api_runtime_role}}');
  });
});
