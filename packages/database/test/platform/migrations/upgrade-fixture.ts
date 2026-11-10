import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';

import {
  migrateDatabase,
  MIGRATIONS_DIRECTORY,
} from '../../../src/migrations.js';
import { createDisposableDatabaseFixture } from '../../../src/testing/postgres/disposable-database.js';

/** Each caller owns its database, sessions and migration history, even in parallel suites. */
export async function withDatabase(
  work: (context: {
    admin: Pool;
    config: Parameters<typeof migrateDatabase>[0];
    directory: string;
  }) => Promise<void>,
  options: { migrate?: false | 'baseline' } = {},
): Promise<void> {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-upgrade-'));
  const admin = new Pool({
    connectionString: fixture.databaseUrl(adminUrl),
    max: 4,
  });
  const config = {
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
    connectionString: fixture.databaseUrl(
      process.env.DATABASE_MIGRATION_URL ??
        'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
    ),
  };
  try {
    await fixture.create();
    if (options.migrate !== false) {
      for (const name of await readdir(MIGRATIONS_DIRECTORY))
        if (
          /^\d{4}_.*\.sql$/u.test(name) &&
          (options.migrate !== 'baseline' || name === '0000_baseline.sql')
        )
          await copyFile(
            join(MIGRATIONS_DIRECTORY, name),
            join(directory, name),
          );
      await migrateDatabase(config, directory);
    }
    await work({ admin, config, directory });
  } finally {
    await admin.end();
    await fixture.drop();
    await rm(directory, { recursive: true, force: true });
  }
}

/** Adoption fixtures model the release before any post-baseline migration. */
export function withBaselineDatabase(work: Parameters<typeof withDatabase>[0]) {
  return withDatabase(work, { migrate: 'baseline' });
}

export async function seedWorkflow(admin: Pool) {
  const ownerId = randomUUID(),
    workspaceId = randomUUID(),
    workflowId = randomUUID();
  await admin.query(
    "insert into app.users(id,email,display_name) values($1,$2,'Upgrade owner')",
    [ownerId, `${ownerId}@example.test`],
  );
  await admin.query(
    "insert into app.workspaces(id,name,slug,created_by) values($1::uuid,'Upgrade workspace',$1::text,$2)",
    [workspaceId, ownerId],
  );
  await admin.query(
    "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Retained workflow',$3)",
    [workflowId, workspaceId, ownerId],
  );
  return { ownerId, workspaceId, workflowId };
}
