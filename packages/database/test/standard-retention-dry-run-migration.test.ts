import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0060_standard_retention_dry_run.sql',
  import.meta.url,
);

describe('standard retention dry-run migration', () => {
  it('freezes typed stage bounds behind fenced maintenance-only pages', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain('dry_run_cursor jsonb');
    expect(migration).toContain('dry_run_upper jsonb');
    expect(migration).toContain("'timestamp_uuid_text_text'");
    expect(migration).toContain(
      "p_dry_run AND p_retention_kind='execution_detail' THEN 'records'",
    );
    expect(migration).toContain('p_lease_fence');
    expect(migration).toContain("'stale'::varchar");
    expect(migration).toContain("'progressed'");
    expect(migration).toContain("'completed'");
    expect(migration).toContain('p_page_limit+1');
    expect(migration).toContain('::timestamptz');
    expect(migration).toContain('::uuid');
    expect(migration).not.toContain('UNION ALL');
    expect(migration).not.toMatch(/candidate_key->'values'\s*[<>]/u);
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*execute_standard_retention_dry_run_page[\s\S]*TO \{\{maintenance_role\}\}/u,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*claim_retention_dry_run_batches[\s\S]*FROM PUBLIC/u,
    );
    expect(migration).not.toMatch(
      /DELETE FROM app\.|UPDATE app\.(?!retention_batches)/u,
    );
  });
});
