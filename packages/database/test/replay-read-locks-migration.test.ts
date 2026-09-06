import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

const migrationUrl = new URL(
  '../migrations/0077_replay_read_locks.sql',
  import.meta.url,
);

describe('replay read-lock migration', () => {
  it('exposes only owner-defined locked reads to the API runtime', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0079_artifact_upload_capacity.sql');
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain(
      'CREATE FUNCTION app.lock_workflow_run_replay_source',
    );
    expect(migration).toContain(
      'CREATE FUNCTION app.lock_workflow_run_replay_version',
    );
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, app, pg_temp');
    expect(migration).toContain('SET row_security = on');
    expect(migration).toContain('FOR SHARE OF run, workflow');
    expect(migration).toContain('p_workspace_id::text IS DISTINCT FROM');
    expect(migration).toContain("ERRCODE = '42501'");
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION app\.lock_workflow_run_replay_source\(uuid, uuid\)[\s\S]*FROM PUBLIC, \{\{api_runtime_role\}\}/u,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION app\.lock_workflow_run_replay_version\(uuid, uuid, uuid\)[\s\S]*FROM PUBLIC, \{\{api_runtime_role\}\}/u,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.lock_workflow_run_replay_source\(uuid, uuid\)[\s\S]*TO \{\{api_runtime_role\}\}/u,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.lock_workflow_run_replay_version\(uuid, uuid, uuid\)[\s\S]*TO \{\{api_runtime_role\}\}/u,
    );
    expect(migration).not.toMatch(/GRANT UPDATE\([^)]*\) ON app\.workflow_/u);
  });
});
