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
import { readFolderScope } from '../../../src/shared/facts.queries.js';
import { workflowAccessible } from '../../../src/tenant-access/resources/workflows.queries.js';

it('keeps populated folders workspace-shared and forces isolation on grant rows after upgrading', async () => {
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
    databaseName: `pertexo_test_folder_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
    connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  });
  const directory = await mkdtemp(
    join(tmpdir(), 'pertexo-before-folder-sharing-'),
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
      if (/^\d{4}_.*\.sql$/u.test(name) && name < '0050_')
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
    const folders = [randomUUID(), randomUUID()];
    const workflows = [randomUUID(), randomUUID()];
    for (const [index, workspaceId] of workspaces.entries()) {
      await owner.query(
        "insert into app.workspaces(id,name,slug,created_by) values($1,'Existing workspace',$2,$3)",
        [workspaceId, `existing-${workspaceId}`, actorId],
      );
      await owner.query(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active')",
        [workspaceId, actorId],
      );
      await owner.query(
        "insert into app.workflow_folders(id,workspace_id,name,name_key) values($1,$2,'Existing folder','existing folder')",
        [folders[index], workspaceId],
      );
      await owner.query(
        "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Existing workflow',$3)",
        [workflows[index], workspaceId, actorId],
      );
      await owner.query(
        'insert into app.workflow_organization_state(workspace_id,workflow_id,folder_id) values($1,$2,$3)',
        [workspaceId, workflows[index], folders[index]],
      );
    }
    const before = (
      await owner.query('select * from app.workflows order by id')
    ).rows;
    expect(await migrateDatabase(config)).toContain('0050_folder_access.sql');
    expect(
      (await owner.query('select * from app.workflows order by id')).rows,
    ).toEqual(before);
    expect(
      (
        await owner.query(
          'select access_mode from app.workflow_folders order by id',
        )
      ).rows,
    ).toEqual([{ access_mode: 'workspace' }, { access_mode: 'workspace' }]);
    expect(
      (
        await owner.query(
          "select relrowsecurity,relforcerowsecurity from pg_class where oid='app.workflow_folder_grants'::regclass",
        )
      ).rows,
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    for (const [index, workspaceId] of workspaces.entries())
      await owner.query(
        "insert into app.workflow_folder_grants(id,workspace_id,folder_id,user_id,access) values($1,$2,$3,$4,'viewer')",
        [randomUUID(), workspaceId, folders[index], actorId],
      );
    for (const [index, workspaceId] of workspaces.entries())
      await withTenantScopedClient(
        api,
        { workspaceId, actorId },
        async (client) => {
          expect(
            (
              await client.query(
                'select workspace_id from app.workflow_folder_grants',
              )
            ).rows,
          ).toEqual([{ workspace_id: workspaceId }]);
          const scope = await readFolderScope(client, { workspaceId, actorId });
          expect(
            await workflowAccessible(client, scope, {
              workspaceId,
              workflowId: workflows[index] ?? '',
            }),
          ).toBe(true);
          expect(scope.permits(folders[index] ?? '', 'workflow:update')).toBe(
            true,
          );
        },
      );
  } finally {
    await api.end();
    await owner.end();
    if (created) await database.drop();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
