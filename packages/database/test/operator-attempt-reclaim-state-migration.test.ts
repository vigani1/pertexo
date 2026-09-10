import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('operator attempt reclaim state migration', () => {
  it('atomically readies the owning node only for a newly reclaimed attempt', async () => {
    const migration = await readFile(
      new URL(
        '../migrations/0086_operator_attempt_reclaim_state.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(migration).toContain("v_command.command_outcome='reclaimed'");
    expect(migration).toContain('NOT v_command.replayed');
    expect(migration).toContain("SET status='ready'");
    expect(migration).toContain('node.current_attempt_id=attempt.id');
    expect(migration).toContain("node.status='running'");
    expect(migration).toContain('v_updated<>1');
    expect(migration).toContain('SET row_security=on');
    expect(migration).toContain('TO {{operator_role}}');
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]*\{\{operator_role\}\}/u,
    );
  });
});
