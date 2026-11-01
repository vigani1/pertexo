import { readFolderScope } from '../../../../src/shared/facts.queries.js';
import { withTenantScopedReadClient } from '@pertexo/database/primitives';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { useIdentityCommandDatabase } from '../../command.support.js';
import {
  authenticateDirectory,
  lockDirectoryOrganization,
} from '../../../../src/identity/federation/provisioning/authority.repository.js';
import {
  createDirectoryUser,
  changeDirectoryUser,
  deleteDirectoryUser,
} from '../../../../src/identity/federation/provisioning/resources/users.repository.js';
import {
  createDirectoryGroup,
  changeDirectoryGroup,
  deleteDirectoryGroup,
} from '../../../../src/identity/federation/provisioning/resources/groups.repository.js';
import {
  bindDirectorySignIn,
  directorySignInCandidate,
} from '../../../../src/identity/federation/provisioning/sign-in.repository.js';
import { directorySessionAllowed } from '../../../../src/identity/federation/provisioning/session.queries.js';
import { withPlatformTransaction } from '@pertexo/database/platform';
import type { DirectoryUserValues } from '../../../../src/identity/federation/provisioning/contract.js';
import type { DirectoryUserRow } from '../../../../src/identity/federation/provisioning/resources/records.queries.js';

const db = useIdentityCommandDatabase('scim_resources');
const values = (
  email = `${randomUUID()}@example.test`,
): DirectoryUserValues => ({
  userName: email,
  active: true,
  externalId: null,
  profile: { emails: [{ value: email, primary: true }] },
});
async function setup() {
  const owner = await db.user('Directory owner'),
    workspaceId = await db.workspace(owner.id);
  const settings = await db.federation().createOrganization({
    workspaceId,
    actorId: owner.id,
    name: 'Directory',
    idempotencyKey: randomUUID(),
  });
  if (settings.organization === null)
    throw new Error('Missing directory organization');
  const organizationId = settings.organization.id;
  const credentialId = randomUUID(),
    digest = randomUUID().replaceAll('-', '').repeat(2);
  await db.asAdmin(
    'insert into app.auth_provisioning_credentials(id,organization_id,name,secret_digest,created_by) values($1,$2,$3,$4,$5)',
    [credentialId, organizationId, 'Fixture', digest, owner.id],
  );
  const pool = db.authenticationPool();
  const principal = await authenticateDirectory(pool, organizationId, digest);
  return {
    owner,
    workspaceId,
    organizationId,
    credentialId,
    digest,
    pool,
    principal,
  };
}
async function bind(
  f: Awaited<ReturnType<typeof setup>>,
  id: string,
  userId: string,
) {
  await withPlatformTransaction(f.pool, async (client) => {
    const organization = await lockDirectoryOrganization(
      client,
      f.organizationId,
    );
    const row = (
      await client.query<DirectoryUserRow>(
        'select * from app.auth_directory_users where id=$1',
        [id],
      )
    ).rows[0];
    if (row === undefined) throw new Error('Missing directory user');
    await bindDirectorySignIn(client, organization, row, userId);
  });
}
const member = (workspaceId: string, userId: string) =>
  db.asAdmin(
    'select role,status,role_revision from app.workspace_memberships where workspace_id=$1 and user_id=$2',
    [workspaceId, userId],
  );

describe('SCIM resources with existing membership authority', () => {
  it('keeps directory users pending until verified sign-in, then removes only managed access atomically', async () => {
    const f = await setup(),
      person = await db.user('Managed person');
    const independent = await db.workspace(f.owner.id);
    await db.member(independent, person.id, 'builder');
    const created = await createDirectoryUser(
      f.pool,
      f.principal,
      values(person.email),
    );
    expect(created.user_id).toBeNull();
    expect(await member(f.workspaceId, person.id)).toEqual([]);
    await bind(f, created.id, person.id);
    expect(await member(f.workspaceId, person.id)).toEqual([
      { role: 'viewer', status: 'active', role_revision: 1 },
    ]);
    expect(
      await db.asAdmin(
        "select actor_user_id,target_type,target_id,metadata from app.audit_events where workspace_id=$1 and target_id=$2 and action='workspace.member_added'",
        [f.workspaceId, person.id],
      ),
    ).toEqual([
      {
        actor_user_id: person.id,
        target_type: 'workspace_member',
        target_id: person.id,
        metadata: {
          source: 'directory',
          organizationId: f.organizationId,
          directoryUserId: created.id,
          role: 'viewer',
          status: 'active',
          roleRevision: 1,
        },
      },
    ]);
    await db.sessions(person.id);
    await changeDirectoryUser(f.pool, f.principal, {
      id: created.id,
      expectedRevision: 2,
      transform: (current) => ({
        userName: current.user_name,
        externalId: null,
        active: false,
        profile: current.profile,
      }),
    });
    expect(await member(f.workspaceId, person.id)).toEqual([
      { role: 'viewer', status: 'removed', role_revision: 2 },
    ]);
    expect(await member(independent, person.id)).toEqual([
      { role: 'builder', status: 'active', role_revision: 1 },
    ]);
    expect(await db.liveSessions(person.id)).toBe(0);
    expect(
      await withPlatformTransaction(f.pool, (client) =>
        directorySessionAllowed(client, f.organizationId, person.id),
      ),
    ).toBe(false);
    await expect(
      withPlatformTransaction(f.pool, (client) =>
        directorySignInCandidate(client, f.organizationId, {
          email: person.email,
          providerId: randomUUID(),
          subject: 'subject',
        }),
      ),
    ).rejects.toHaveProperty('name', 'SignInProofRejectedError');
  });

  it('preserves manual roles and the recovery owner, including manually removed memberships', async () => {
    const f = await setup(),
      person = await db.user('Manual person');
    await db.member(f.workspaceId, person.id, 'builder');
    const personRow = await createDirectoryUser(
      f.pool,
      f.principal,
      values(person.email),
    );
    const ownerRow = await createDirectoryUser(
      f.pool,
      f.principal,
      values(f.owner.email),
    );
    await bind(f, personRow.id, person.id);
    await bind(f, ownerRow.id, f.owner.id);
    await deleteDirectoryUser(f.pool, f.principal, personRow.id, 2);
    await deleteDirectoryUser(f.pool, f.principal, ownerRow.id, 2);
    expect(await member(f.workspaceId, person.id)).toEqual([
      { role: 'builder', status: 'active', role_revision: 1 },
    ]);
    expect(await member(f.workspaceId, f.owner.id)).toEqual([
      { role: 'owner', status: 'active', role_revision: 1 },
    ]);
    expect(
      await db.asAdmin(
        'select * from app.auth_directory_memberships where workspace_id=$1',
        [f.workspaceId],
      ),
    ).toEqual([]);
  });

  it('applies ordered group roles, falls back on deletion, and updates both resource ETags', async () => {
    const f = await setup(),
      person = await db.user('Group person');
    const user = await createDirectoryUser(
      f.pool,
      f.principal,
      values(person.email),
    );
    await bind(f, user.id, person.id);
    const group = await createDirectoryGroup(f.pool, f.principal, {
      displayName: 'Builders',
      externalId: null,
      memberIds: [],
    });
    await db.asAdmin(
      'insert into app.auth_directory_group_mappings(organization_id,workspace_id,group_id,role,priority) values($1,$2,$3,$4,0)',
      [f.organizationId, f.workspaceId, group.id, 'builder'],
    );
    const updated = await changeDirectoryGroup(f.pool, f.principal, {
      id: group.id,
      expectedRevision: 1,
      transform: (current) => ({
        displayName: current.display_name,
        externalId: current.external_id,
        memberIds: [user.id],
      }),
    });
    expect(updated.memberIds).toEqual([user.id]);
    expect(await member(f.workspaceId, person.id)).toEqual([
      { role: 'builder', status: 'active', role_revision: 2 },
    ]);
    expect(
      await db.asAdmin(
        'select revision from app.auth_directory_users where id=$1',
        [user.id],
      ),
    ).toEqual([{ revision: 3 }]);
    const folderId = randomUUID(),
      workflowId = randomUUID();
    await db.asAdmin(
      "insert into app.workflow_folders(workspace_id,id,name,name_key,access_mode) values($1,$2,'Directory private','directory private','restricted')",
      [f.workspaceId, folderId],
    );
    await db.asAdmin(
      "insert into app.workflows(workspace_id,id,name,created_by) values($1,$2,'Directory workflow',$3)",
      [f.workspaceId, workflowId, f.owner.id],
    );
    await db.asAdmin(
      'insert into app.workflow_organization_state(workspace_id,workflow_id,folder_id) values($1,$2,$3)',
      [f.workspaceId, workflowId, folderId],
    );
    await db.asAdmin(
      "insert into app.workflow_folder_grants(id,workspace_id,folder_id,organization_id,group_id,access) values($1,$2,$3,$4,$5,'editor')",
      [randomUUID(), f.workspaceId, folderId, f.organizationId, group.id],
    );
    const access = () =>
      withTenantScopedReadClient(
        f.pool,
        { workspaceId: f.workspaceId, actorId: person.id },
        async (client) =>
          (
            await readFolderScope(client, {
              workspaceId: f.workspaceId,
              actorId: person.id,
            })
          ).permits(folderId, 'workflow:read'),
      );
    expect(await access()).toBe(true);
    await deleteDirectoryGroup(f.pool, f.principal, group.id, 2);
    expect(await access()).toBe(false);
    expect(
      await db.asAdmin(
        'select id from app.workflow_folder_grants where workspace_id=$1 and folder_id=$2',
        [f.workspaceId, folderId],
      ),
    ).toEqual([]);

    expect(
      await db.asAdmin(
        'select revision from app.auth_organizations where id=$1',
        [f.organizationId],
      ),
    ).toEqual([{ revision: 2 }]);
    expect(await member(f.workspaceId, person.id)).toEqual([
      { role: 'viewer', status: 'active', role_revision: 3 },
    ]);
    expect(
      await db.asAdmin(
        'select revision from app.auth_directory_users where id=$1',
        [user.id],
      ),
    ).toEqual([{ revision: 4 }]);
  });

  it('rolls back a late invalid member, rejects a stale ETag and revocation, and isolates organizations', async () => {
    const f = await setup(),
      other = await setup();
    const user = await createDirectoryUser(f.pool, f.principal, values());
    await expect(
      changeDirectoryUser(other.pool, other.principal, {
        id: user.id,
        expectedRevision: 1,
        transform: () => values(),
      }),
    ).rejects.toHaveProperty('reason', 'not_found');
    await expect(
      changeDirectoryUser(f.pool, f.principal, {
        id: user.id,
        expectedRevision: 99,
        transform: () => values(),
      }),
    ).rejects.toHaveProperty('reason', 'stale');
    const group = await createDirectoryGroup(f.pool, f.principal, {
      displayName: 'Atomic',
      externalId: null,
      memberIds: [],
    });
    await expect(
      changeDirectoryGroup(f.pool, f.principal, {
        id: group.id,
        expectedRevision: 1,
        transform: () => ({
          displayName: 'Changed',
          externalId: null,
          memberIds: [user.id, randomUUID()],
        }),
      }),
    ).rejects.toHaveProperty('reason', 'invalid_value');
    expect(
      await db.asAdmin(
        'select display_name,revision from app.auth_directory_groups where id=$1',
        [group.id],
      ),
    ).toEqual([{ display_name: 'Atomic', revision: 1 }]);
    await db.asAdmin(
      'update app.auth_provisioning_credentials set revoked_at=clock_timestamp() where id=$1',
      [f.credentialId],
    );
    await expect(
      createDirectoryUser(f.pool, f.principal, values()),
    ).rejects.toHaveProperty('reason', 'unauthorized');
    await expect(
      authenticateDirectory(f.pool, f.organizationId, f.digest),
    ).rejects.toHaveProperty('reason', 'unauthorized');
  });
});
