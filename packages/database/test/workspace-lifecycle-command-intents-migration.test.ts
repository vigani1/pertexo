import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0047_workspace_lifecycle_command_intents.sql',
  import.meta.url,
);

describe('workspace lifecycle command intent migration', () => {
  it('keeps API intent authority separate from lifecycle command authority', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain(
      'CREATE TABLE app.workspace_lifecycle_operations',
    );
    expect(migration).toContain(
      "status IN ('pending','running','completed','failed')",
    );
    expect(migration).toContain('FOR UPDATE SKIP LOCKED LIMIT p_limit');
    expect(migration).toContain('lease_fence=operation.lease_fence+1');
    expect(migration).toContain('idempotency_key_hash char(64) NOT NULL');
    expect(migration).not.toContain('idempotency_key varchar');
    expect(migration).toContain('TO {{api_runtime_role}}');
    expect(migration).toContain('TO {{lifecycle_command_role}}');
    expect(migration).not.toContain(
      'app.project_workspace_deletion(uuid,bigint,uuid,varchar,uuid,char,char,varchar,varchar,varchar,timestamptz,interval)\n  TO {{lifecycle_command_role}}',
    );
    expect(migration).toContain(
      "p_command_type NOT IN ('deletion_requested','deletion_restored')",
    );
  });
});
