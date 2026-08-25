import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';

describe('webhook trigger migration contract', () => {
  it('forces tenant isolation and keeps endpoint credentials non-public', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0040_schedule_triggers.sql');
    const migration = await readFile(
      new URL('../migrations/0039_webhook_triggers.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain('workflow_triggers_version_node_unique');
    expect(migration).toContain('webhook_trigger_secret_versions_immutable');
    expect(migration).toContain('resolve_public_webhook_endpoint');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('expires_at timestamptz NOT NULL');
    expect(migration).toContain('previous_secret_valid_until timestamptz');
    expect(migration).not.toMatch(
      /raw_(body|bytes)|request_headers|signature_header/u,
    );
  });
});
