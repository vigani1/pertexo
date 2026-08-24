import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0032_for_each_barriers.sql',
  import.meta.url,
);

describe('For Each barrier migration', () => {
  it('permits only explicitly typed undated barriers and leaves timed waits strict', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('DROP CONSTRAINT node_runs_wait_state_valid');
    expect(sql).toContain("control_kind = 'for_each_barrier'");
    expect(sql).toMatch(/resume_at IS NULL\s+AND retry_due_at IS NULL/u);
    expect(sql).toContain('control_kind IS NULL');
    expect(sql).toContain('resume_at IS NOT NULL OR retry_due_at IS NOT NULL');
    expect(sql).not.toMatch(/UPDATE\s+app\.node_runs/iu);
    expect(sql).not.toContain('TO {{api_runtime_role}}');
  });
});
