import { readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import {
  expectedMigrationHistoryFrom,
  parseExpectedMigrationHistory,
} from './support/migration-history-fixture.js';

describe('retained migration history fixture', () => {
  it('matches the exact current migration suffix independently', async () => {
    const expected = await expectedMigrationHistoryFrom(
      '0021_workflow_integration_usage.sql',
    );
    const current = (await readdir(MIGRATIONS_DIRECTORY))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
      .sort();
    expect(expected).toEqual(current.slice(current.indexOf(expected[0] ?? '')));
    expect(expected.at(-1)).toBe('0113_workflow_run_statistics_index.sql');
  });

  it('returns an exact suffix and rejects a missing start', async () => {
    const suffix = await expectedMigrationHistoryFrom(
      '0087_workspace_maintenance_rerun_purge.sql',
    );
    expect(suffix).toEqual([
      '0087_workspace_maintenance_rerun_purge.sql',
      '0088_sql_boundary_integrity.sql',
      '0089_oidc_capacity_lock_time.sql',
      '0090_workspace_discovery_policy.sql',
      '0091_workspace_discovery_scope.sql',
      '0092_workflow_run_history_indexes.sql',
      '0093_workspace_member_role_management.sql',
      '0094_workspace_invitations.sql',
      '0095_workspace_invitation_lifecycle_safety.sql',
      '0096_workspace_invitation_claim_cleanup_progress.sql',
      '0097_workspace_invitation_claim_scan_restart.sql',
      '0098_workspace_display_name.sql',
      '0099_workflow_recent_list.sql',
      '0100_workspace_invitation_delivery_snapshot.sql',
      '0101_better_auth_foundation.sql',
      '0102_better_auth_session_lifecycle.sql',
      '0103_durable_authentication_mail.sql',
      '0104_auth_email_change_session_revocation.sql',
      '0105_owned_auth_email_proofs.sql',
      '0106_auth_method_link_attempts.sql',
      '0107_legacy_method_migration_attempts.sql',
      '0108_workflow_name_revision.sql',
      '0113_workflow_run_statistics_index.sql',
    ]);
    await expect(
      expectedMigrationHistoryFrom('9999_missing.sql'),
    ).rejects.toThrow('fixture is missing 9999_missing.sql');
  });

  it.each([
    ['non-array', { name: '0001_valid.sql' }],
    ['empty', []],
    ['non-string entry', ['0001_valid.sql', 2]],
    ['invalid name', ['migration.sql']],
    ['duplicate', ['0001_valid.sql', '0001_valid.sql']],
    ['unordered', ['0002_second.sql', '0001_first.sql']],
  ])('rejects %s fixture content', (_label, candidate) => {
    expect(() => parseExpectedMigrationHistory(candidate)).toThrow();
  });
});
