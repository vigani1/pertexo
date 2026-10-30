import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WorkspaceAccessDeniedError } from '../../../../src/tenant-access/errors.js';
import { useIdentityCommandDatabase } from '../../command.support.js';
import {
  createDirectoryCredential,
  revokeDirectoryCredential,
} from '../../../../src/identity/federation/provisioning/management/credentials.repository.js';
import {
  replaceDirectoryMappings,
  adoptDirectoryMembership,
} from '../../../../src/identity/federation/provisioning/management/mappings.repository.js';
import { unlinkDirectoryWorkspace } from '../../../../src/identity/federation/provisioning/management/unlink.repository.js';
import {
  authenticateDirectory,
  lockDirectoryOrganization,
} from '../../../../src/identity/federation/provisioning/authority.repository.js';
import { createDirectoryUser } from '../../../../src/identity/federation/provisioning/resources/users.repository.js';
import { createDirectoryGroup } from '../../../../src/identity/federation/provisioning/resources/groups.repository.js';
import { readDirectoryUser } from '../../../../src/identity/federation/provisioning/resources/users.repository.js';
import { bindDirectorySignIn } from '../../../../src/identity/federation/provisioning/sign-in.repository.js';
import { withPlatformTransaction } from '../../../../src/tenant-access/transactions.js';

const db = useIdentityCommandDatabase('scim_manage');
async function setup() {
  const owner = await db.user('Directory owner'),
    workspaceId = await db.workspace(owner.id);
  const settings = await db.federation().createOrganization({
    workspaceId,
    actorId: owner.id,
    name: 'Directory',
    idempotencyKey: randomUUID(),
  });
  if (settings.organization === null) throw new Error('Missing organization');
  const scope = { workspaceId, actorId: owner.id },
    pool = db.authenticationPool();
  return { scope, owner, pool, organizationId: settings.organization.id };
}
async function machine(f: Awaited<ReturnType<typeof setup>>) {
  const issued = await createDirectoryCredential(f.pool, {
    ...f.scope,
    name: 'Directory client',
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  if (issued.replayed) throw new Error('Fresh credential replayed');
  return authenticateDirectory(
    f.pool,
    f.organizationId,
    createHash('sha256').update(issued.secret).digest('hex'),
  );
}

describe('directory ownership and command receipts', () => {
  it('shows a credential once, bounds active credentials, and preserves authority when its creator loses ownership', async () => {
    const f = await setup();
    const command = {
      ...f.scope,
      name: 'Show once',
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    };
    const first = await createDirectoryCredential(f.pool, command);
    if (first.replayed) throw new Error('Fresh credential replayed');
    expect(await createDirectoryCredential(f.pool, command)).toEqual({
      replayed: true,
      credential: first.credential,
    });
    const stored = await db.asAdmin(
      'select result_ref from app.idempotency_records where workspace_id=$1',
      [f.scope.workspaceId],
    );
    expect(JSON.stringify(stored)).not.toContain(first.secret);
    for (let revision = 2; revision <= 5; revision++)
      await createDirectoryCredential(f.pool, {
        ...f.scope,
        name: 'Another client',
        expectedRevision: revision,
        idempotencyKey: randomUUID(),
      });
    await expect(
      createDirectoryCredential(f.pool, {
        ...f.scope,
        name: 'Too many',
        expectedRevision: 6,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toHaveProperty('reason', 'limit');
    const replacement = await db.user('Replacement owner');
    await db.asAdmin(
      "update app.workspace_memberships set role='admin',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
      [f.scope.workspaceId, f.owner.id],
    );
    await db.member(f.scope.workspaceId, replacement.id, 'owner');
    const digest = createHash('sha256').update(first.secret).digest('hex');
    await expect(
      authenticateDirectory(f.pool, f.organizationId, digest),
    ).resolves.toHaveProperty('credentialId', first.credential.id);
    await expect(
      revokeDirectoryCredential(f.pool, {
        ...f.scope,
        expectedRevision: 6,
        credentialId: first.credential.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    await revokeDirectoryCredential(f.pool, {
      ...f.scope,
      actorId: replacement.id,
      expectedRevision: 6,
      credentialId: first.credential.id,
      idempotencyKey: randomUUID(),
    });
    await expect(
      authenticateDirectory(f.pool, f.organizationId, digest),
    ).rejects.toHaveProperty('reason', 'unauthorized');
  });

  it('adopts an existing active grant only after verified binding and exact reviewed role/revisions', async () => {
    const f = await setup(),
      principal = await machine(f),
      person = await db.user('Existing builder');
    await db.member(f.scope.workspaceId, person.id, 'builder');
    const user = await createDirectoryUser(f.pool, principal, {
      userName: person.email,
      externalId: null,
      active: true,
      profile: { emails: [{ value: person.email, primary: true }] },
    });
    const group = await createDirectoryGroup(f.pool, principal, {
      displayName: 'Operators',
      externalId: null,
      memberIds: [user.id],
    });
    await replaceDirectoryMappings(f.pool, {
      ...f.scope,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
      mappings: [
        {
          workspaceId: f.scope.workspaceId,
          groupId: group.id,
          role: 'operator',
          priority: 0,
        },
      ],
    });
    const command = {
      ...f.scope,
      expectedRevision: 3,
      targetWorkspaceId: f.scope.workspaceId,
      directoryUserId: user.id,
      directoryRevision: 3,
      membershipRevision: 1,
      role: 'operator' as const,
      idempotencyKey: randomUUID(),
    };
    await expect(
      adoptDirectoryMembership(f.pool, command),
    ).rejects.toHaveProperty('reason', 'invalid_value');
    await withPlatformTransaction(f.pool, async (client) => {
      const organization = await lockDirectoryOrganization(
        client,
        f.organizationId,
      );
      await bindDirectorySignIn(
        client,
        organization,
        await readDirectoryUser(client, f.organizationId, user.id),
        person.id,
      );
    });
    await expect(
      adoptDirectoryMembership(f.pool, { ...command, role: 'builder' }),
    ).rejects.toHaveProperty('reason', 'stale');
    await db.sessions(person.id);
    await adoptDirectoryMembership(f.pool, command);
    await adoptDirectoryMembership(f.pool, command);
    expect(
      await db.asAdmin(
        'select role,status,role_revision from app.workspace_memberships where workspace_id=$1 and user_id=$2',
        [f.scope.workspaceId, person.id],
      ),
    ).toEqual([{ role: 'operator', status: 'active', role_revision: 2 }]);
    expect(await db.liveSessions(person.id)).toBe(0);
    await expect(
      db.identity().changeWorkspaceMemberRole({
        workspaceId: f.scope.workspaceId,
        actorUserId: f.owner.id,
        targetUserId: person.id,
        role: 'admin',
        expectedRoleRevision: 2,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toHaveProperty('name', 'DirectoryManagedMembershipError');
  });

  it('lets the linked workspace owner unlink, revokes its managed grants and leaves manual access intact', async () => {
    const f = await setup(),
      principal = await machine(f),
      target = await db.workspace(f.owner.id);
    await db.federation().linkWorkspace({
      ...f.scope,
      targetWorkspaceId: target,
      defaultRole: 'viewer',
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    const person = await db.user('Managed person'),
      manual = await db.user('Manual person'),
      localOwner = await db.user('Local owner');
    await db.member(target, manual.id, 'builder');
    const user = await createDirectoryUser(f.pool, principal, {
      userName: person.email,
      externalId: null,
      active: true,
      profile: { emails: [{ value: person.email, primary: true }] },
    });
    await withPlatformTransaction(f.pool, async (client) => {
      const organization = await lockDirectoryOrganization(
        client,
        f.organizationId,
      );
      await bindDirectorySignIn(
        client,
        organization,
        await readDirectoryUser(client, f.organizationId, user.id),
        person.id,
      );
    });
    await db.asAdmin(
      "update app.workspace_memberships set role='admin',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
      [target, f.owner.id],
    );
    await db.member(target, localOwner.id, 'owner');
    await db.sessions(person.id);
    const command = {
      workspaceId: target,
      actorId: localOwner.id,
      targetWorkspaceId: target,
      expectedRevision: 3,
      idempotencyKey: randomUUID(),
    };
    await unlinkDirectoryWorkspace(f.pool, command);
    await unlinkDirectoryWorkspace(f.pool, command);
    expect(
      await db.asAdmin(
        'select status from app.workspace_memberships where workspace_id=$1 and user_id=$2',
        [target, person.id],
      ),
    ).toEqual([{ status: 'removed' }]);
    expect(
      await db.asAdmin(
        'select status from app.workspace_memberships where workspace_id=$1 and user_id=$2',
        [f.scope.workspaceId, person.id],
      ),
    ).toEqual([{ status: 'active' }]);
    expect(
      await db.asAdmin(
        'select role,status from app.workspace_memberships where workspace_id=$1 and user_id=$2',
        [target, manual.id],
      ),
    ).toEqual([{ role: 'builder', status: 'active' }]);
    expect(
      await db.asAdmin(
        'select user_id from app.auth_directory_memberships where workspace_id=$1',
        [target],
      ),
    ).toEqual([]);
    expect(await db.liveSessions(person.id)).toBe(0);
  });
});
