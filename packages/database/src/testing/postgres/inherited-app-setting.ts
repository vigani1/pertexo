import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { migrateDatabase } from '../../migrations.js';
import { createDisposableDatabaseFixture } from './disposable-database.js';

const SETTING = /^app\.[a-z0-9_]+$/u;

/**
 * A migrated disposable database in which the application role inherits an
 * app.* setting as a role default, as a contaminated deployment would. The
 * default lives in that database only and goes with it.
 */
export async function createDatabaseWithInheritedAppSetting(
  input: Readonly<{
    adminUrl: string;
    migrationUrl: string;
    setting: string;
    value: string;
  }>,
): Promise<
  Readonly<{
    databaseUrl: (base: string) => string;
    drop: () => Promise<void>;
  }>
> {
  if (!SETTING.test(input.setting))
    throw new Error('Inherited setting must be an app.* name');
  const databaseName = `pertexo_test_inherited_boot_${randomUUID().replaceAll('-', '')}`;
  const fixture = createDisposableDatabaseFixture({
    adminUrl: input.adminUrl,
    connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
    databaseName,
    ownerRole: 'pertexo_owner',
  });
  const databaseUrl = (base: string): string => {
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    return url.toString();
  };
  await fixture.create();
  try {
    await migrateDatabase({
      connectionString: databaseUrl(input.migrationUrl),
      ownerRole: 'pertexo_owner',
      appRole: 'pertexo_app',
      maintenanceRole: 'pertexo_maintenance',
    });
    const admin = new Pool({
      connectionString: databaseUrl(input.adminUrl),
      max: 1,
    });
    try {
      const { rows } = await admin.query<{ literal: string }>(
        'select quote_literal($1) as literal',
        [input.value],
      );
      await admin.query(
        `alter role pertexo_app in database "${databaseName}" set ${input.setting} = ${rows[0]?.literal ?? "''"}`,
      );
    } finally {
      await admin.end();
    }
  } catch (error: unknown) {
    await fixture.drop();
    throw error;
  }
  return Object.freeze({ databaseUrl, drop: () => fixture.drop() });
}
