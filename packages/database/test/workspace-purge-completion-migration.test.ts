import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';

const migrationUrl = new URL(
  '../migrations/0059_workspace_purge_completion.sql',
  import.meta.url,
);

describe('workspace purge completion migration', () => {
  it('persists one fenced completion command and minimizes the tombstone', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0070_preview_execution_deadline.sql');
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain('CREATE TABLE app.workspace_purge_completions');
    expect(migration).toContain("completion.status='running'");
    expect(migration).toContain(
      'workspace purge completion high water changed',
    );
    expect(migration).toContain(
      'active workspace legal hold blocks purge completion',
    );
    expect(migration).toContain('authorize_workspace_purge_completion_append');
    expect(migration).toContain("date_trunc('milliseconds',clock_timestamp())");
    expect(migration).toContain(
      "workspace purge completion is not claimable' USING ERRCODE='55P03'",
    );
    expect(migration).toContain(
      'v_completion.lease_token IS DISTINCT FROM p_lease_token',
    );
    expect(migration).toContain("'deletion_completed'");
    expect(migration).toContain("NEW.name:='Deleted workspace'");
    expect(migration).toContain("NEW.slug:='deleted-'||NEW.id::text");
    expect(migration).toContain('NEW.created_by:=NULL');
    expect(migration).toMatch(
      /UPDATE app\.workspace_purge_jobs SET status='completed'[\s\S]*app\.project_workspace_deletion/u,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.find_due_workspace_purge_completion[\s\S]*TO \{\{maintenance_role\}\}/u,
    );
    expect(migration).not.toMatch(
      /GRANT[\s\S]*TO \{\{(?:api_runtime_role|lifecycle_command_role)\}\}/u,
    );
  });
});
