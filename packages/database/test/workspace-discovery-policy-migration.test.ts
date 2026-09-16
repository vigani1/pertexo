import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0091_workspace_discovery_scope.sql',
  import.meta.url,
);

describe('workspace discovery policy migration', () => {
  it('limits cross-workspace reads to the configured actor and active memberships', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('workspace_memberships_actor_discovery');
    expect(sql).toContain('FOR SELECT');
    expect(sql).toContain('{{api_runtime_role}}');
    expect(sql).toContain("current_setting('app.actor_id', true)");
    expect(sql).toContain("current_setting('app.discovery_scope', true)");
    expect(sql).toContain("current_setting('app.workspace_id', true)");
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain('DROP POLICY');
  });
});
