import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';
import { expect, it } from 'vitest';

import {
  migrateDatabase,
  MIGRATIONS_DIRECTORY,
} from '../../../src/migrations.js';
import { createDisposableDatabaseFixture } from '../../support/postgres/disposable-database.js';

import { OAUTH2_TABLES, seedWorkspace } from './fixture.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

/** The last migration before this feature, so the install below is a real old one. */
const BEFORE_OAUTH2 = /^00(?:[0-5][0-9]|6[0-6])_.*\.sql$/u;

// Plan, "Database": migration on a database with existing connections leaves them unchanged.
it.fails(
  'the migration leaves existing connections unchanged',
  async () => {
    const fixture = createDisposableDatabaseFixture({
      adminUrl,
      connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
      databaseName: `pertexo_test_oauth2_upgrade_${randomUUID().replaceAll('-', '')}`,
      ownerRole: 'pertexo_owner',
    });
    const directory = await mkdtemp(join(tmpdir(), 'pertexo-oauth2-upgrade-'));
    let admin: Pool | undefined;
    try {
      await fixture.create();
      for (const name of await readdir(MIGRATIONS_DIRECTORY))
        if (BEFORE_OAUTH2.test(name))
          await copyFile(
            join(MIGRATIONS_DIRECTORY, name),
            join(directory, name),
          );
      const config = {
        appRole: 'pertexo_app',
        ownerRole: 'pertexo_owner',
        maintenanceRole: 'pertexo_maintenance',
        connectionString: fixture.databaseUrl(migrationUrl),
      };
      await migrateDatabase(config, directory);
      admin = new Pool({
        connectionString: fixture.databaseUrl(adminUrl),
        max: 1,
      });
      const { workspaceId, ownerId } = await seedWorkspace(admin);
      for (const [authType, providerKey] of [
        ['http_headers', 'http'],
        ['slack_bot_token', 'slack'],
      ] as const) {
        const connectionId = randomUUID();
        const secretVersionId = randomUUID();
        await admin.query('begin');
        await admin.query(
          "insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by) values($1,$2,$3,$4,$5,'active',$6,$7)",
          [
            connectionId,
            workspaceId,
            providerKey,
            `Existing ${authType}`,
            authType,
            secretVersionId,
            ownerId,
          ],
        );
        await admin.query(
          "insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by) values($1,$2,$3,'alias/existing','Zg','Zg',repeat('A',16),repeat('A',22),$4)",
          [secretVersionId, workspaceId, connectionId, ownerId],
        );
        await admin.query('commit');
      }
      const snapshot = async () =>
        (
          await (admin as Pool).query(
            `select to_jsonb(c) as connection, to_jsonb(s) as secret
             from app.connections c
             join app.connection_secret_versions s
               on s.connection_id=c.id and s.workspace_id=c.workspace_id
            where c.workspace_id=$1 order by c.name`,
            [workspaceId],
          )
        ).rows;
      const before = await snapshot();
      expect(before).toHaveLength(2);

      await migrateDatabase(config);

      expect(await snapshot()).toEqual(before);
      for (const table of OAUTH2_TABLES) {
        const { rows } = await admin.query<{ count: number }>(
          `select count(*)::int as count from app.${table}`,
        );
        expect(rows).toEqual([{ count: 0 }]);
      }
    } finally {
      await admin?.end();
      await fixture.drop();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
