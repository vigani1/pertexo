import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../migrations/0050_workspace_lifecycle_api_authority.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('workspace lifecycle API authority migration', () => {
  it('removes direct lifecycle projection from the API role', () => {
    expect(migration).toContain('REVOKE UPDATE (');
    expect(migration).toContain('status,deletion_requested_at');
    expect(migration).toContain('purge_after');
    expect(migration).not.toContain('purge_after,updated_at');
    expect(migration).toContain('FROM {{api_runtime_role}}');
  });
});
