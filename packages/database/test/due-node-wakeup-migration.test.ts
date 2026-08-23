import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0031_due_node_wakeups.sql',
  import.meta.url,
);

describe('due node wakeup migration', () => {
  it('atomically claims each PostgreSQL due fact and creates a canonical coordinator event', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('due_wakeup_at');
    expect(sql).toMatch(/FOR UPDATE[\s\S]*SKIP LOCKED/iu);
    expect(sql).toContain("'advance-workflow-run'");
    expect(sql).toContain("'workflow-run'");
    expect(sql).toContain('sha256');
    expect(sql).toContain('p_limit IS NULL');
    expect(sql).toContain('node_runs_due_wakeup_consistent');
    expect(sql).toContain(
      'GRANT UPDATE (due_wakeup_at) ON app.node_runs TO {{worker_runtime_role}}',
    );
    expect(sql).toContain('TO {{worker_runtime_role}}');
    expect(sql).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE)\s+ON\s+app\.node_runs/iu,
    );
    expect(sql).not.toContain('TO {{api_runtime_role}}');
  });
});
