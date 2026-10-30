import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { workspaceMemberships } from '../../../../src/testing.js';

import { identityDatabase, tenantDatabase, ownerUserId } from '../fixture.js';

// ADR 037/042: admins manage only builder, operator and viewer members; nobody
// changes their own role.
export function registerForbidsRoleTransitionsOutsidePolicy(): void {
  it('refuses admin promotions and peer-admin changes, and leaves the member unchanged', async () => {
    const workspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Role policy',
      slug: `role-policy-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });
    const [admin, peerAdmin, builder] = await Promise.all(
      ['Admin', 'Peer admin', 'Builder'].map((displayName) =>
        identityDatabase.createUser({
          email: `${randomUUID()}@example.test`,
          displayName,
        }),
      ),
    );
    if (admin === undefined || peerAdmin === undefined || builder === undefined)
      throw new Error('Role policy users were not created');
    await tenantDatabase.withWorkspace(workspace.id, async ({ db }) => {
      await db.insert(workspaceMemberships).values([
        {
          workspaceId: workspace.id,
          userId: admin.id,
          role: 'admin',
          status: 'active',
        },
        {
          workspaceId: workspace.id,
          userId: peerAdmin.id,
          role: 'admin',
          status: 'active',
        },
        {
          workspaceId: workspace.id,
          userId: builder.id,
          role: 'builder',
          status: 'active',
        },
      ]);
    });
    const changeAsAdmin = (
      targetUserId: string,
      role: 'admin' | 'builder' | 'operator' | 'viewer',
    ) =>
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: workspace.id,
        actorUserId: admin.id,
        targetUserId,
        role,
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });

    await expect(changeAsAdmin(builder.id, 'admin')).rejects.toMatchObject({
      reason: 'transition_forbidden',
    });
    await expect(changeAsAdmin(peerAdmin.id, 'viewer')).rejects.toMatchObject({
      reason: 'transition_forbidden',
    });
    const members = await identityDatabase.listWorkspaceMembers(
      workspace.id,
      ownerUserId,
    );
    expect(
      members.items.filter(({ userId }) =>
        [builder.id, peerAdmin.id].includes(userId),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: builder.id,
          role: 'builder',
          roleRevision: 1,
        }),
        expect.objectContaining({
          userId: peerAdmin.id,
          role: 'admin',
          roleRevision: 1,
        }),
      ]),
    );

    await expect(changeAsAdmin(builder.id, 'operator')).resolves.toMatchObject({
      role: 'operator',
      roleRevision: 2,
      changed: true,
    });
  });

  it('refuses an owner changing their own role', async () => {
    const workspace = await identityDatabase.createWorkspaceWithOwner({
      name: 'Own role',
      slug: `own-role-${randomUUID().slice(0, 8)}`,
      ownerUserId,
    });

    await expect(
      identityDatabase.changeWorkspaceMemberRole({
        workspaceId: workspace.id,
        actorUserId: ownerUserId,
        targetUserId: ownerUserId,
        role: 'admin',
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'self_change' });
  });
}
