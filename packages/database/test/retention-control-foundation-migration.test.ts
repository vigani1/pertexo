import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

const migrationUrl = new URL(
  '../migrations/0044_retention_control_foundation.sql',
  import.meta.url,
);

describe('retention control foundation migration contract', () => {
  it('is a non-destructive, least-privilege control-plane migration', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe(
      '0078_workflow_lifecycle_revision.sql',
    );
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain('workspace_control_ledger_projection');
    expect(migration).toContain('workspace_legal_holds');
    expect(migration).toContain('retention_batches');
    expect(migration).toContain(
      'ON app.workflow_runs (workspace_id, input_ref_expires_at, id)',
    );
    expect(migration).toContain('retention_batches_dry_run_only');
    expect(migration).toContain('retention.batch_started');
    expect(migration).toContain('subject_id uuid NOT NULL');
    expect(migration).toContain("'deletion_requested'");
    expect(migration).toContain('must land before production data');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('TO {{maintenance_role}}');
    expect(migration).not.toContain('retention_destruction_guard');
    expect(migration).not.toMatch(/DELETE\s+FROM\s+app\./iu);
    expect(migration).not.toMatch(/SET\s+input_ref\s*=\s*NULL/iu);
  });
});
