import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0057_workspace_tenant_rows_purge.sql',
  import.meta.url,
);
const invitationMigrationUrl = new URL(
  '../migrations/0096_workspace_invitation_claim_cleanup_progress.sql',
  import.meta.url,
);
const invitationRestartMigrationUrl = new URL(
  '../migrations/0097_workspace_invitation_claim_scan_restart.sql',
  import.meta.url,
);

describe('workspace tenant-row purge migration', () => {
  it('keeps pages bounded, fenced, hold-safe, and maintenance-only', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain('p_page_size NOT BETWEEN 1 AND 500');
    expect(migration).toContain(
      'workspace tenant-row purge high water changed',
    );
    expect(migration).toContain(
      'active workspace legal hold blocks tenant-row purge page',
    );
    expect(migration).toContain('hold.released_sequence IS NULL');
    expect(migration).toContain('workspace_purge_immutable_delete_is_armed');
    expect(migration).toContain('workspace_creation_idempotency_records');
    expect(migration).toContain('transport_security_audit_facts_minimized');
    expect(migration).toContain('workspace tenant-row purge has residual rows');
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.find_due_workspace_purge_step\(\),[\s\S]*TO \{\{maintenance_role\}\}/u,
    );
    expect(migration).not.toMatch(
      /GRANT[\s\S]*TO \{\{(?:api_runtime_role|lifecycle_command_role)\}\}/u,
    );
    expect(migration).not.toContain("'deletion_completed'");
  });

  it('includes bounded, two-sided invitation replacement claim cleanup', async () => {
    const migration = await readFile(invitationMigrationUrl, 'utf8');

    expect(migration).toContain('workspace_invitation_claim_cleanup_cursors');
    expect(migration).toContain('scan_workspace_invitation_replacement_claims');
    expect(migration).toContain("''workspace_purge'',p_job_id,v_workspace_id");
    expect(migration).toContain('LIMIT p_limit');
    expect(migration).toContain('cycle_completed');
    expect(migration).toContain('high_water_updated_at');
  });

  it('installs the next purge boundary in one constraint-valid transition', async () => {
    const migration = await readFile(invitationRestartMigrationUrl, 'utf8');

    expect(migration).toContain('v_state.high_water_updated_at IS NULL OR');
    expect(migration).toMatch(
      /SET cursor_updated_at=v_state\.high_water_updated_at,[\s\S]*high_water_updated_at=v_next_high_water_updated_at,[\s\S]*cycle_completed=false/u,
    );
    expect(migration).not.toMatch(
      /SET cursor_updated_at=high_water_updated_at,[\s\S]{0,400}high_water_updated_at=NULL/u,
    );
  });
});
