import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seedReferenceIndexOwners } from '../artifacts/reference-index.fixture.js';
import { withUpgradeDatabase } from '../platform/migrations/upgrade-fixture.js';

it('contains organization links and mappings without exposing unrelated workspace storage', async () => {
  await withUpgradeDatabase(116, async ({ admin, upgrade }) => {
    const organizations: { id: string; workspaces: string[] }[] = [];
    for (let i = 0; i < 2; i++) {
      const a = await seedReferenceIndexOwners(admin),
        b = await seedReferenceIndexOwners(admin),
        id = randomUUID(),
        group = randomUUID();
      await admin.query(
        "insert into app.auth_organizations(id,control_workspace_id,name) values($1,$2,'Scoped organization')",
        [id, a.workspaceId],
      );
      await admin.query(
        'insert into app.auth_organization_workspaces(workspace_id,organization_id) values($1,$3),($2,$3)',
        [a.workspaceId, b.workspaceId, id],
      );
      await admin.query(
        "insert into app.auth_directory_groups(id,organization_id,display_name) values($1,$2,'Scoped group')",
        [group, id],
      );
      for (const workspaceId of [a.workspaceId, b.workspaceId])
        await admin.query(
          "insert into app.auth_directory_group_mappings(organization_id,workspace_id,group_id,role,priority) values($1,$2,$3,'viewer',0)",
          [id, workspaceId, group],
        );

      organizations.push({
        id,
        workspaces: [a.workspaceId, b.workspaceId].sort(),
      });
    }
    expect(
      (
        await admin.query<{ count: number }>(
          'select count(*)::integer count from app.workflow_runs',
        )
      ).rows[0]?.count,
    ).toBeGreaterThanOrEqual(4);
    await upgrade();
    const client = await admin.connect();
    try {
      await client.query("select set_config('app.workspace_id','',false)");
      for (const context of [
        undefined,
        '',
        'malformed',
        ...organizations.map((o) => o.id),
      ]) {
        await client.query('begin');
        await client.query('set local role pertexo_app');
        if (context !== undefined)
          await client.query(
            "select set_config('app.organization_id',$1,true)",
            [context],
          );
        const expected =
          organizations.find((o) => o.id === context)?.workspaces ?? [];
        for (const table of [
          'auth_organization_workspaces',
          'auth_directory_group_mappings',
        ]) {
          expect(
            (
              await client.query<{ workspace_id: string }>(
                `select workspace_id from app.${table} order by workspace_id`,
              )
            ).rows.map((row) => row.workspace_id),
          ).toEqual(expected);
        }
        const foreign = organizations.find((o) => o.id !== context)
          ?.workspaces[0];
        for (const [table, role] of [
          ['auth_organization_workspaces', 'default_role'],
          ['auth_directory_group_mappings', 'role'],
        ] as const)
          expect(
            (
              await client.query(
                `update app.${table} set ${role}='admin' where workspace_id=$1 returning workspace_id`,
                [foreign],
              )
            ).rows,
          ).toEqual([]);
        expect(
          (await client.query('select id from app.workflow_runs')).rows,
        ).toEqual([]);
        await client.query('rollback');
      }
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
}, 120_000);
