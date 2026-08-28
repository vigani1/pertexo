import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';
import { MIGRATIONS_DIRECTORY } from '../src/migrations.js';

describe('preview execution deadline migration', () => {
  it('separates the immutable execution deadline from retention expiry', async () => {
    const sql = await readFile(
      new URL(
        '../migrations/0070_preview_execution_deadline.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(EXPECTED_MIGRATION_HEAD).toBe('0071_oidc_browser_binding.sql');
    expect(MIGRATIONS_DIRECTORY).toContain('migrations');
    expect(sql).toContain('ADD COLUMN execution_deadline_at timestamptz');
    expect(sql).toContain(
      'ALTER TABLE app.preview_runs NO FORCE ROW LEVEL SECURITY',
    );
    expect(sql).toContain("created_at + interval '5 minutes'");
    expect(sql).toContain(
      'ALTER TABLE app.preview_runs FORCE ROW LEVEL SECURITY',
    );
    expect(sql).toContain('execution_deadline_at <= expires_at');
    expect(sql).toContain(
      'OLD.created_at, OLD.execution_deadline_at, OLD.expires_at',
    );
  });
});
