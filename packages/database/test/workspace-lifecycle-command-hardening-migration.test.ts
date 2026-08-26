import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0048_workspace_lifecycle_command_hardening.sql',
  import.meta.url,
);

describe('workspace lifecycle command hardening migration', () => {
  it('binds authorization and projection to one live leased operation', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain('lease_expires_at>clock_timestamp()');
    expect(migration).toContain('lease_acquired_at=v_now');
    expect(migration).toContain('lease_expires_at=v_now+p_lease_interval');
    expect(migration).toContain('append_authorized_at IS NULL');
    expect(migration).toContain(
      'CREATE FUNCTION app.project_and_complete_workspace_lifecycle_operation',
    );
    expect(migration).toContain(
      'DROP FUNCTION app.project_workspace_lifecycle_command',
    );
    expect(migration).toContain('UPDATE app.sessions session_record');
  });
});
