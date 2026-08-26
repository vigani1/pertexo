import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';

const migrationUrl = new URL(
  '../migrations/0045_control_ledger_command_lock.sql',
  import.meta.url,
);

describe('control ledger command lock migration contract', () => {
  it('exposes only narrow non-destructive maintenance functions', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe(
      '0058_workspace_object_versions_purge.sql',
    );
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain('lock_workspace_control_ledger');
    expect(migration).toContain('read_workspace_control_command');
    expect(migration).toContain('validate_workspace_legal_hold_command');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('TO {{maintenance_role}}');
    expect(migration).toContain("ERRCODE='22023'");
    expect(migration).toContain("ERRCODE='23503'");
    expect(migration).not.toMatch(/DELETE\s+FROM\s+app\./iu);
    expect(migration).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE)/iu);
  });
});
