import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';

const migrationUrl = new URL(
  '../migrations/0043_workflow_run_input_retention.sql',
  import.meta.url,
);

describe('workflow run input retention migration contract', () => {
  it('backfills and constrains the separate 30-day input expiry deadline', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe(
      '0043_workflow_run_input_retention.sql',
    );
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain('ADD COLUMN input_ref_expires_at timestamptz');
    expect(migration).toContain("created_at + interval '30 days'");
    expect(migration).toContain('workflow_runs_input_ref_expiry_valid');
    expect(migration).toContain('input_ref IS NULL');
    expect(migration).toContain('input_ref_expires_at IS NULL');
  });
});
