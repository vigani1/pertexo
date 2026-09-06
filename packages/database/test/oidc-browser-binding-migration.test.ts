import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

describe('OIDC browser binding migration', () => {
  it('invalidates old transactions and requires a fixed-width binding digest', async () => {
    const sql = await readFile(
      new URL('../migrations/0071_oidc_browser_binding.sql', import.meta.url),
      'utf8',
    );

    expect(EXPECTED_MIGRATION_HEAD).toBe(
      '0080_expired_artifact_upload_retention.sql',
    );
    expect(sql).toContain('ADD COLUMN browser_binding_digest char(64)');
    expect(sql).toContain("browser_binding_digest = repeat('0', 64)");
    expect(sql).toContain(
      'consumed_at = COALESCE(consumed_at, clock_timestamp())',
    );
    expect(sql).toContain('ALTER COLUMN browser_binding_digest SET NOT NULL');
    expect(sql).toContain("browser_binding_digest ~ '^[0-9a-f]{64}$'");
  });
});
