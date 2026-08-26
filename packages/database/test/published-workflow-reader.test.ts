import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';

const migrationUrl = new URL(
  '../migrations/0013_published_workflow_execution.sql',
  import.meta.url,
);

describe('published workflow execution migration contract', () => {
  it('adds a V2 executable envelope while preserving V1 rows', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0056_workspace_purge_foundation.sql');

    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('executable_schema_version integer');
    expect(sql).toContain('executable_json jsonb');
    expect(sql).toContain('compatibility_release_epoch integer');
    expect(sql).toContain("checksum ~ '^wf:v1:sha256:[0-9a-f]{64}$'");
    expect(sql).toContain("checksum ~ '^wf:v2:sha256:[0-9a-f]{64}$'");
    expect(sql).toContain('octet_length(executable_json::text) <= 1048576');
  });

  it('grants the worker only the execution projection columns', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain(
      'CREATE POLICY workflow_versions_worker_execution_read',
    );
    expect(sql).toMatch(
      /GRANT SELECT \(\s*id, workspace_id, workflow_id, version_number, schema_version,\s*checksum, executable_schema_version, executable_json,\s*compatibility_release_epoch\s*\)\s*ON app\.workflow_versions TO \{\{worker_runtime_role\}\}/su,
    );
    expect(sql).not.toMatch(
      /GRANT SELECT \([^)]*graph_json[^)]*\)[^;]*worker_runtime_role/su,
    );
  });
});
