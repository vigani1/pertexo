import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seedWorkflow, withDatabase } from './upgrade-fixture.js';

it('keeps provider organization lookups indexed and rejects duplicate organization links after index cleanup', async () => {
  await withDatabase(async ({ admin }) => {
    const { workspaceId } = await seedWorkflow(admin);
    await admin.query(
      `insert into app.auth_organizations(id,control_workspace_id,name) values($1,$1,'Organization')`,
      [workspaceId],
    );
    const provider = randomUUID();
    const insert = `insert into app.auth_providers(id,organization_id,kind,name,issuer,configuration) values($1,$2,'saml','Provider','https://example.test','{}')`;
    await admin.query(insert, [provider, workspaceId]);

    await admin.query('set enable_seqscan=off');
    const plan = JSON.stringify(
      (
        await admin.query(
          `explain select id from app.auth_providers where organization_id=$1`,
          [workspaceId],
        )
      ).rows,
    );
    expect(plan).toContain('Index');
    expect(plan).not.toContain('Sort');
    await expect(
      admin.query(insert, [provider, workspaceId]),
    ).rejects.toMatchObject({ code: '23505' });
    const link = `insert into app.auth_organization_workspaces(workspace_id,organization_id) values($1,$1)`;
    await admin.query(link, [workspaceId]);
    await expect(admin.query(link, [workspaceId])).rejects.toMatchObject({
      code: '23505',
    });
  });
}, 60_000);
