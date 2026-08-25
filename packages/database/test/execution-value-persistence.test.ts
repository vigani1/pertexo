import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';
import { EXECUTION_JSONB_DATABASE_BACKSTOP_BYTES_V1 } from '../src/stored-execution-value.js';

const migrationUrl = new URL(
  '../migrations/0014_execution_value_persistence.sql',
  import.meta.url,
);

describe('execution value persistence migration contract', () => {
  it('adds a nullable run input without a partial checkpoint identity invariant', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0039_webhook_triggers.sql');
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('ADD COLUMN input_ref jsonb');
    expect(sql).not.toContain('ADD COLUMN workflow_version_id');
    expect(sql).not.toContain('run_checkpoints_run_version_workspace_fk');
  });

  it('widens only durable value and checkpoint JSON backstops', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(EXECUTION_JSONB_DATABASE_BACKSTOP_BYTES_V1).toBe(4_194_304);
    expect(sql.match(/<= 4194304/g)).toHaveLength(6);
    for (const constraint of [
      'workflow_runs_input_ref_bounded',
      'workflow_runs_output_ref_bounded',
      'run_checkpoints_scheduler_state_bounded',
      'node_runs_input_ref_bounded',
      'node_runs_output_ref_bounded',
      'node_attempts_output_ref_bounded',
    ])
      expect(sql).toContain(constraint);
    expect(sql).not.toContain('node_runs_branch_context_bounded');
    expect(sql).not.toContain('node_attempts_reconciliation_ref_bounded');
    expect(sql).not.toContain('run_events_payload_bounded');
  });

  it('does not add runtime mutation grants or tighten legacy value shapes', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).not.toMatch(/GRANT\s+(?:UPDATE|INSERT|DELETE)/iu);
    expect(sql).not.toMatch(/jsonb_typeof|schemaVersion|artifactId/iu);
  });
});
