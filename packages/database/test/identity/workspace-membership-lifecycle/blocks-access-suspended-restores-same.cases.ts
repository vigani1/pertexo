import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import { database, command, membership, facts, team } from './fixture.js';

export function registerBlocksAccessSuspendedRestoresSame(): void {
  it('blocks access while suspended and restores the same role', async () => {
    const { owner, workspaceId, members } = await team('builder');
    const [builder = ''] = members;
    await database.sessions(builder);
    const suspend = command(workspaceId, owner, builder);

    await expect(
      database.identity().suspendWorkspaceMember(suspend),
    ).resolves.toEqual({
      userId: builder,
      roleRevision: 2,
      membershipStatus: 'suspended',
      replayed: false,
    });
    await expect(database.liveSessions(builder)).resolves.toBe(0);
    await expect(
      database.identity().findWorkspaceAccess(builder, workspaceId),
    ).resolves.toMatchObject({ membershipStatus: 'suspended' });
    await expect(
      database.identity().listAccessibleWorkspaces(builder),
    ).resolves.toMatchObject({ items: [] });
    const listed = await database
      .identity()
      .listWorkspaceMembers(workspaceId, owner);
    expect(listed.items).toContainEqual(
      expect.objectContaining({
        userId: builder,
        membershipStatus: 'suspended',
        roleRevision: 2,
      }),
    );
    await expect(
      database.identity().suspendWorkspaceMember(suspend),
    ).resolves.toMatchObject({ replayed: true, roleRevision: 2 });
    await expect(
      database
        .identity()
        .suspendWorkspaceMember(command(workspaceId, owner, builder, 2)),
    ).rejects.toMatchObject({ reason: 'target_inactive' });
    await expect(
      database
        .identity()
        .reactivateWorkspaceMember(command(workspaceId, owner, builder, 1)),
    ).rejects.toMatchObject({ reason: 'revision_conflict' });

    await database.sessions(builder);
    await expect(
      database
        .identity()
        .reactivateWorkspaceMember(command(workspaceId, owner, builder, 2)),
    ).resolves.toMatchObject({
      roleRevision: 3,
      membershipStatus: 'active',
      replayed: false,
    });
    await expect(membership(workspaceId, builder)).resolves.toEqual({
      status: 'active',
      role: 'builder',
      role_revision: 3,
    });
    await expect(database.liveSessions(builder)).resolves.toBe(0);
    await expect(
      database
        .identity()
        .reactivateWorkspaceMember(command(workspaceId, owner, builder, 3)),
    ).rejects.toMatchObject({ reason: 'target_inactive' });
    await expect(
      facts(workspaceId, 'workspace.member_suspended'),
    ).resolves.toEqual([
      {
        actor_user_id: owner,
        target_id: builder,
        metadata: { role: 'builder', fromRevision: 1, toRevision: 2 },
      },
    ]);
    await expect(
      facts(workspaceId, 'workspace.member_reactivated'),
    ).resolves.toHaveLength(1);
  });

  it('allows owners any non-owner and admins only operational roles', async () => {
    const { owner, workspaceId, members } = await team(
      'admin',
      'admin',
      'builder',
      'viewer',
    );
    const [admin = '', peer = '', builder = '', viewer = ''] = members;
    const suspend = (input: ReturnType<typeof command>) =>
      database.identity().suspendWorkspaceMember(input);

    for (const [actor, target, reason] of [
      [admin, peer, 'command_forbidden'],
      [admin, owner, 'owner_target'],
      [admin, admin, 'self_command'],
      [owner, owner, 'self_command'],
      [builder, viewer, 'actor_inactive'],
      [owner, randomUUID(), 'target_missing'],
    ] as const)
      await expect(
        suspend(command(workspaceId, actor, target)),
      ).rejects.toMatchObject({ reason });

    await expect(
      suspend(command(workspaceId, admin, builder)),
    ).resolves.toMatchObject({ membershipStatus: 'suspended' });
    await expect(
      suspend(command(workspaceId, owner, peer)),
    ).resolves.toMatchObject({ membershipStatus: 'suspended' });
    // A suspended admin manages nobody until reactivated.
    await expect(
      suspend(command(workspaceId, peer, viewer)),
    ).rejects.toMatchObject({ reason: 'actor_inactive' });
    // ADR 042 still removes a suspended member; then it is gone for good.
    await expect(
      database
        .identity()
        .removeWorkspaceMember(command(workspaceId, owner, builder, 2)),
    ).resolves.toMatchObject({ roleRevision: 3 });
    await expect(
      database
        .identity()
        .reactivateWorkspaceMember(command(workspaceId, owner, builder, 3)),
    ).rejects.toMatchObject({ reason: 'target_removed' });
  });
}
