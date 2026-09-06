import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

const migrationUrl = new URL(
  '../migrations/0054_workflow_run_input_retention_scheduling.sql',
  import.meta.url,
);

describe('workflow-run-input retention scheduling migration', () => {
  it('adds bounded durable maintenance-only scheduling', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0077_replay_read_locks.sql');
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain('retention_schedule_state');
    expect(migration).toContain('FOR UPDATE OF workspace,state SKIP LOCKED');
    expect(migration).toContain('p_limit NOT BETWEEN 1 AND 25');
    expect(migration).toContain('run.input_ref_expires_at<=v_cutoff_at');
    expect(migration).toContain("batch.status<>'completed'");
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.schedule_workflow_run_input_retention\(integer\)[\s\S]*TO \{\{maintenance_role\}\}/u,
    );
  });
});
