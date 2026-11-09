import { expect, it } from 'vitest';
import { withUpgradeDatabase } from '../platform/migrations/upgrade-fixture.js';

it('preserves populated organization links on upgrade and isolates their role assignments', async () => {
  await withUpgradeDatabase(116, async ({ admin, upgrade }) => {
    await admin.query(`INSERT INTO app.users(id,email,display_name) VALUES ('11111111-1111-4111-8111-111111111111','review@example.test','Reviewer');
INSERT INTO app.workspaces(id,name,slug,created_by) VALUES ('22222222-2222-4222-8222-222222222222','A','review-a','11111111-1111-4111-8111-111111111111'),('33333333-3333-4333-8333-333333333333','B','review-b','11111111-1111-4111-8111-111111111111');
INSERT INTO app.auth_organizations(id,control_workspace_id,name) VALUES ('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222','Review');
INSERT INTO app.auth_organization_workspaces(workspace_id,organization_id) SELECT id,'44444444-4444-4444-8444-444444444444' FROM app.workspaces;
INSERT INTO app.auth_directory_groups(id,organization_id,display_name) VALUES ('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444','Review');
INSERT INTO app.auth_directory_group_mappings SELECT '44444444-4444-4444-8444-444444444444',id,'55555555-5555-4555-8555-555555555555','viewer',0 FROM app.workspaces;
`);
    const tables = [
      ['auth_organization_workspaces', 'default_role'],
      ['auth_directory_group_mappings', 'role'],
    ] as const;
    const snapshot = async () =>
      Promise.all(
        tables.map(
          async ([table]) =>
            (
              await admin.query<{ row: unknown }>(
                `select to_jsonb(t) row from app.${table} t order by workspace_id`,
              )
            ).rows,
        ),
      );
    const before = await snapshot();
    await upgrade();
    expect(await snapshot()).toEqual(before);
    const client = await admin.connect();
    try {
      for (const [table, role] of tables) {
        for (const context of [
          undefined,
          '',
          'malformed',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
        ]) {
          await client.query('begin');
          await client.query('set local role pertexo_app');
          if (context !== undefined)
            await client.query(
              "select set_config('app.workspace_id',$1,true)",
              [context],
            );
          const scoped =
            context === '22222222-2222-4222-8222-222222222222' ||
            context === '33333333-3333-4333-8333-333333333333';
          const foreignWorkspace =
            context === '33333333-3333-4333-8333-333333333333'
              ? '22222222-2222-4222-8222-222222222222'
              : '33333333-3333-4333-8333-333333333333';
          expect(
            (await client.query(`select workspace_id from app.${table}`)).rows,
          ).toEqual(scoped ? [{ workspace_id: context }] : []);
          expect(
            (
              await client.query(
                `update app.${table} set ${role}='admin' where workspace_id=$1 returning workspace_id`,
                [foreignWorkspace],
              )
            ).rows,
          ).toEqual([]);
          if (scoped)
            expect(
              (
                await client.query(
                  `update app.${table} set ${role}='admin' where workspace_id=$1 returning workspace_id`,
                  [context],
                )
              ).rows,
            ).toEqual([{ workspace_id: context }]);
          await client.query('rollback');
        }
      }
    } finally {
      await client.query('rollback');
      client.release();
    }
    expect(await snapshot()).toEqual(before);
  });
}, 120_000);
