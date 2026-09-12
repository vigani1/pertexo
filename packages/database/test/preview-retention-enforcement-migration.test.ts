import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0053_preview_retention_enforcement.sql',
  import.meta.url,
);
const legacyDeliveryUrl = new URL(
  '../src/lifecycle/preview-cleanup.ts',
  import.meta.url,
);
const lifecycleTestingUrl = new URL(
  '../src/lifecycle/testing.ts',
  import.meta.url,
);

describe('preview retention enforcement migration', () => {
  it('moves bounded preview destruction behind maintenance authority', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain('artifacts_preview_destruction_guard');
    expect(migration).toContain('preview_retention_transition_capabilities');
    expect(migration).toContain('pg_current_xact_id()');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('workspace_legal_holds');
    expect(migration).toContain('p_expected_control_sequence');
    expect(migration).toContain('p_expected_control_hash');
    expect(migration).toContain('p_quiescence_seconds NOT BETWEEN 1 AND 120');
    expect(migration).toContain(
      'REVOKE EXECUTE ON FUNCTION app.complete_preview_cleanup(uuid,uuid)',
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*find_due_preview_cleanup[\s\S]*TO \{\{maintenance_role\}\}/u,
    );
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*preview_artifact_cleanup[\s\S]*TO \{\{worker_runtime_role\}\}/u,
    );
  });

  it('does not retain the revoked delivery implementation as a testing export', async () => {
    await expect(readFile(legacyDeliveryUrl, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(lifecycleTestingUrl, 'utf8')).resolves.not.toContain(
      './preview-cleanup.js',
    );
  });
});
