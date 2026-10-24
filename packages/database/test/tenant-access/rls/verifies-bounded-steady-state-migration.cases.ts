import { expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../../../src/platform/readiness.queries.js';

import { database, executeAsOwner } from './fixture.js';

export function registerVerifiesBoundedSteadyStateMigration(): void {
  it('verifies bounded steady-state migration, PostgreSQL, and role readiness', async () => {
    await expect(database.checkReadiness()).resolves.toEqual({
      migrationHead: EXPECTED_MIGRATION_HEAD,
      postgresMajor: 18,
      role: 'pertexo_app',
    });
  });

  it('detects an incompatible migration head', async () => {
    await executeAsOwner(`
        insert into pertexo_internal.schema_migrations (name, checksum)
        values ('9999_incompatible.sql', 'test-only')
      `);
    try {
      await expect(database.checkReadiness()).rejects.toThrow(
        'Database migration head is incompatible',
      );
    } finally {
      await executeAsOwner(`
          delete from pertexo_internal.schema_migrations
          where name = '9999_incompatible.sql'
        `);
    }
  });
}
