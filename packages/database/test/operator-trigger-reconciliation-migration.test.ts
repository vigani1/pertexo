import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('operator trigger reconciliation migration', () => {
  it('grants only the narrow request wrapper and emits a fresh normal delivery', async () => {
    const migration = await readFile(
      new URL(
        '../migrations/0064_operator_trigger_reconciliation.sql',
        import.meta.url,
      ),
      'utf8',
    );
    expect(migration).toContain(
      'CREATE FUNCTION app.retry_operator_trigger_reconciliation(',
    );
    expect(migration).toContain("'reconcile-workflow-triggers'");
    expect(migration).toContain("'publishedVersionId',v_published_version_id");
    expect(migration).toContain("WHEN p_dry_run THEN 'would_retry'");
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION app.retry_operator_trigger_reconciliation(',
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]*\{\{operator_role\}\}/u,
    );
  });
});
