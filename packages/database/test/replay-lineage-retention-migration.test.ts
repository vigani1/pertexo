import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

const migrationUrl = new URL(
  '../migrations/0076_replay_lineage_retention.sql',
  import.meta.url,
);

describe('replay lineage retention migration', () => {
  it('keeps summary deletion behind the replay-source lineage fence', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0078_workflow_lifecycle_revision.sql');
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION app.execute_standard_retention_page',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION app.standard_retention_dry_run_stage_keys',
    );
    expect(migration).toContain('AND child.replay_source_run_id=run.id');
    expect(migration).toContain('retention control high water changed');
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.execute_standard_retention_page[\s\S]*TO \{\{maintenance_role\}\}/u,
    );
  });
});
