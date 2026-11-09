import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../platform/migrations/upgrade-fixture.js';

it.each(['auth_organization_workspaces', 'auth_directory_group_mappings'])(
  'refuses foreign inserts, deletes and workspace reassignment on real %s rows',
  async (table) => {
    await withUpgradeDatabase(119, async ({ admin }) => {
      const a = await seedWorkflow(admin);
      const b = await seedWorkflow(admin);
      const c = await seedWorkflow(admin);
      const organization = randomUUID();
      const group = randomUUID();
      await admin.query(
        "insert into app.auth_organizations(id,control_workspace_id,name) values($1,$2,'Write isolation')",
        [organization, a.workspaceId],
      );
      const mappings = table === 'auth_directory_group_mappings';
      await admin.query(
        'insert into app.auth_organization_workspaces(organization_id,workspace_id) select $1,unnest($2::uuid[])',
        [
          organization,
          mappings
            ? [a.workspaceId, b.workspaceId, c.workspaceId]
            : [a.workspaceId, b.workspaceId],
        ],
      );
      if (mappings) {
        await admin.query(
          "insert into app.auth_directory_groups(id,organization_id,display_name) values($1,$2,'Write isolation')",
          [group, organization],
        );
        await admin.query(
          "insert into app.auth_directory_group_mappings(organization_id,workspace_id,group_id,role,priority) select $1,unnest($2::uuid[]),$3,'viewer',0",
          [organization, [a.workspaceId, b.workspaceId], group],
        );
      }
      const snapshot = async () =>
        (
          await admin.query<{ row: unknown }>(
            `select to_jsonb(t) row from app.${table} t order by workspace_id`,
          )
        ).rows;
      const before = await snapshot();
      expect(before).toHaveLength(2);
      const client = await admin.connect();
      try {
        await client.query('begin');
        await client.query('set local role pertexo_app');
        await client.query("select set_config('app.workspace_id',$1,true)", [
          a.workspaceId,
        ]);
        expect(
          (
            await client.query(
              `delete from app.${table} where workspace_id=$1 returning workspace_id`,
              [b.workspaceId],
            )
          ).rows,
        ).toEqual([]);
        await client.query('savepoint forbidden_write');
        await expect(
          client.query(
            `update app.${table} set workspace_id=$1 where workspace_id=$2`,
            [c.workspaceId, a.workspaceId],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await client.query('rollback to savepoint forbidden_write');
        const insert = mappings
          ? client.query(
              "insert into app.auth_directory_group_mappings(organization_id,workspace_id,group_id,role,priority) values($1,$2,$3,'admin',0)",
              [organization, c.workspaceId, group],
            )
          : client.query(
              "insert into app.auth_organization_workspaces(organization_id,workspace_id,default_role) values($1,$2,'admin')",
              [organization, c.workspaceId],
            );
        await expect(insert).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.query('rollback');
        client.release();
      }
      expect(await snapshot()).toEqual(before);
    });
  },
  120_000,
);
