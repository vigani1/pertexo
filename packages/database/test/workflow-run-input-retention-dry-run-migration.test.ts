import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../migrations/0051_workflow_run_input_retention_dry_run.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('workflow-run-input retention dry-run migration', () => {
  it('adds bounded maintenance-only inventory without tenant mutation', () => {
    expect(migration).toContain('p_page_limit NOT BETWEEN 1 AND 1000');
    expect(migration).toContain('LIMIT p_page_limit+1');
    expect(migration).toContain('input_ref_expires_at<=v_batch.cutoff_at');
    expect(migration).toContain("'retention.batch_completed'");
    expect(migration).toContain('TO {{maintenance_role}}');
    expect(migration).not.toMatch(/UPDATE app\.workflow_runs/u);
    expect(migration).not.toMatch(/DELETE FROM app\.workflow_runs/u);
  });
});
