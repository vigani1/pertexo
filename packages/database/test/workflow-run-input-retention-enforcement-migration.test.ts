import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../migrations/0052_workflow_run_input_retention_enforcement.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('workflow-run-input retention enforcement migration', () => {
  it('requires bounded fenced maintenance mutation with hold and high-water gates', () => {
    expect(migration).toContain("status='paused'");
    expect(migration).toContain("pause_reason='legal_hold'");
    expect(migration).toContain(
      'workspace.retention_control_sequence=p_expected_control_sequence',
    );
    expect(migration).toContain(
      'workspace.retention_control_hash=p_expected_control_hash',
    );
    expect(migration).toContain('p_page_limit NOT BETWEEN 1 AND 1000');
    expect(migration).toContain('SET input_ref=NULL,input_ref_expires_at=NULL');
    expect(migration).toContain(
      'app.checkpoint_retention_batch(uuid,uuid,bigint,timestamptz,uuid,integer,integer,boolean)',
    );
    expect(migration).toContain('FROM {{maintenance_role}}');
    expect(migration).toContain('TO {{maintenance_role}}');
  });
});
