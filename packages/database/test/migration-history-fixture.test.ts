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
    expect(expected.at(-1)).toBe('0093_workspace_member_role_management.sql');
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
