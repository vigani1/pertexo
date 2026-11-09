import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { db, organization, admin, federation, directory } from './fixture.js';
import { readDirectoryManagement } from '../../../../src/identity/federation/provisioning/management/commands.repository.js';

it('derives organization from the authorized workspace without widening reader authority', async () => {
  const o = await organization(),
    p = await organization(),
    adminId = await admin(o);
  for (const entry of [o, p]) {
    const group = randomUUID();
    await db.asAdmin(
      "insert into app.auth_directory_groups(id,organization_id,display_name) values($1,$2,'Reader group')",
      [group, entry.organizationId],
    );
    for (const workspace of [entry.control, entry.linked])
      await db.asAdmin(
        "insert into app.auth_directory_group_mappings(organization_id,workspace_id,group_id,role,priority) values($1,$2,$3,'viewer',0)",
        [entry.organizationId, workspace, group],
      );
  }
  const asReader = {
    workspaceId: o.control,
    actorId: adminId,
    organizationId: p.organizationId,
  };
  const revision = (await federation.settings(o.scope)).organization?.revision;
  if (revision === undefined) throw new Error('Missing organization revision');
  const credential = await directory.createCredential({
    ...o.scope,
    name: 'Owner secret',
    expectedRevision: revision,
    idempotencyKey: randomUUID(),
  });
  if (credential.replayed) throw new Error('Fresh credential replayed');
  const settings = await directory.settings(asReader);
  expect(settings.canManage).toBe(false);
  expect(JSON.stringify(settings)).not.toContain(credential.secret);
  await expect(
    federation.domainChallenge({ ...asReader, domainId: o.pendingDomainId }),
  ).rejects.toHaveProperty('reason', 'owner_required');
  await expect(
    directory.createCredential({
      ...asReader,
      name: 'Not allowed',
      expectedRevision: revision + 1,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toThrow();
  expect((await directory.settings(o.scope)).credentials).toHaveLength(1);
  const visible = await readDirectoryManagement(
    db.authenticationPool(),
    asReader,
    async (client, org, { canManage }) => ({
      organization: org.id,
      canManage,
      links: (
        await client.query<{ workspace_id: string }>(
          'select workspace_id from app.auth_organization_workspaces order by workspace_id',
        )
      ).rows.map((row) => row.workspace_id),
      mappings: (
        await client.query<{ workspace_id: string }>(
          'select workspace_id from app.auth_directory_group_mappings order by workspace_id',
        )
      ).rows.map((row) => row.workspace_id),
    }),
  );
  expect(visible).toEqual({
    organization: o.organizationId,
    canManage: false,
    links: [o.control, o.linked].sort(),
    mappings: [o.control, o.linked].sort(),
  });
});
