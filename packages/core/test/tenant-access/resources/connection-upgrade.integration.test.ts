import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import {
  migrateDatabase,
  MIGRATIONS_DIRECTORY,
  createDisposableDatabaseFixture,
} from '@pertexo/database/testing';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import {
  readConnectionScope,
  connectionScopeSql,
} from '../../../src/tenant-access/resources/connections/scope.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { connections as storedConnections } from '@pertexo/database/schema';

it('keeps populated connections workspace-shared and forces isolation on shares after upgrading', async () => {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const migrationUrl =
    process.env.DATABASE_MIGRATION_URL ??
    'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
  const apiUrl =
    process.env.DATABASE_URL ??
    'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
  const database = createDisposableDatabaseFixture({
    adminUrl,
    databaseName: `pertexo_test_conn_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
    connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  });
  const directory = await mkdtemp(
    join(tmpdir(), 'pertexo-before-connection-sharing-'),
  );
  const owner = new Pool({
    connectionString: database.databaseUrl(adminUrl),
    max: 1,
  });
  const api = new Pool({
    connectionString: database.databaseUrl(apiUrl),
    max: 1,
  });
  let created = false;
  try {
    await database.create();
    created = true;
    for (const name of await readdir(MIGRATIONS_DIRECTORY))
      if (/^\d{4}_.*\.sql$/u.test(name) && name < '0051_')
        await copyFile(join(MIGRATIONS_DIRECTORY, name), join(directory, name));
    const config = {
      connectionString: database.databaseUrl(migrationUrl),
      ownerRole: 'pertexo_owner',
      appRole: 'pertexo_app',
      maintenanceRole: 'pertexo_maintenance',
    };
    await migrateDatabase(config, directory);
    const actorId = randomUUID();
    await owner.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Existing member')",
      [actorId, `${actorId}@example.test`],
    );
    const workspaces = [randomUUID(), randomUUID()];
    const connections = [randomUUID(), randomUUID()];
    const secrets = [randomUUID(), randomUUID()];
    for (const [index, workspaceId] of workspaces.entries()) {
      await owner.query(
        "insert into app.workspaces(id,name,slug,created_by) values($1,'Existing workspace',$2,$3)",
        [workspaceId, `existing-${workspaceId}`, actorId],
      );
      await owner.query(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active')",
        [workspaceId, actorId],
      );
      const client = await owner.connect();
      try {
        await client.query('begin');
        await client.query(
          "insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by) values($1,$2,'http','Existing headers','http_headers','active',$3,$4)",
          [connections[index], workspaceId, secrets[index], actorId],
        );
        await client.query(
          "insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by) values($1,$2,$3,'alias/fixture','Zg','Zg',repeat('A',16),repeat('A',22),$4)",
          [secrets[index], workspaceId, connections[index], actorId],
        );
        await client.query('commit');
      } finally {
        await client.query('rollback');
        client.release();
      }
    }
    const before = (
      await owner.query(
        'select id,current_secret_version_id from app.connections order by id',
      )
    ).rows;
    expect(await migrateDatabase(config)).toContain(
      '0051_connection_sharing.sql',
    );
    expect(
      (
        await owner.query(
          'select id,current_secret_version_id from app.connections order by id',
        )
      ).rows,
    ).toEqual(before);
    expect(
      (await owner.query('select access_mode from app.connections order by id'))
        .rows,
    ).toEqual([{ access_mode: 'workspace' }, { access_mode: 'workspace' }]);
    expect(
      (
        await owner.query(
          "select relrowsecurity,relforcerowsecurity from pg_class where oid='app.connection_shares'::regclass",
        )
      ).rows,
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    for (const [index, workspaceId] of workspaces.entries())
      await owner.query(
        'insert into app.connection_shares(workspace_id,connection_id,user_id) values($1,$2,$3)',
        [workspaceId, connections[index], actorId],
      );
    for (const [index, workspaceId] of workspaces.entries())
      await withTenantScopedClient(
        api,
        { workspaceId, actorId },
        async (client) => {
          expect(
            (
              await client.query(
                'select workspace_id from app.connection_shares',
              )
            ).rows,
          ).toEqual([{ workspace_id: workspaceId }]);
          const scope = await readConnectionScope(
            client,
            { workspaceId, actorId },
            'connection:use',
          );
          const connection = alias(storedConnections, 'connection');
          expect(
            await drizzle(client)
              .select({ id: connection.id })
              .from(connection)
              .where(connectionScopeSql(scope, connection)),
          ).toEqual([{ id: connections[index] }]);
        },
      );
  } finally {
    await api.end();
    await owner.end();
    if (created) await database.drop();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
