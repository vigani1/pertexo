import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';

const migrationUrl = new URL(
  '../migrations/0055_standard_retention_classes.sql',
  import.meta.url,
);

describe('standard retention classes migration', () => {
  it('keeps all destructive retention behind bounded maintenance functions', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0056_workspace_purge_foundation.sql');
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain("'execution_detail'");
    expect(migration).toContain("'run_summary'");
    expect(migration).toContain("'trigger_summary'");
    expect(migration).toContain("'audit_security'");
    expect(migration).toContain('p_page_limit NOT BETWEEN 1 AND 1000');
    expect(migration).toContain('workspace_legal_holds');
    expect(migration).toContain('retention control high water changed');
    expect(migration).toContain('find_due_run_artifact_retention');
    expect(migration).toContain('complete_run_artifact_retention');
    expect(migration).toContain('defer_run_artifact_retention');
    expect(migration).toContain('lock_execution_artifact_references');
    expect(migration).toContain('FOR SHARE');
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.execute_standard_retention_page[\s\S]*TO \{\{maintenance_role\}\}/u,
    );
    expect(migration).not.toMatch(
      /GRANT (?:DELETE|UPDATE)[\s\S]*TO \{\{(?:api_runtime_role|worker_runtime_role|dispatcher_role)\}\}/u,
    );
  });
});
