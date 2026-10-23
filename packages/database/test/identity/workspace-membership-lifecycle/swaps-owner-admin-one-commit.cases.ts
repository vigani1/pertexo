import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  database,
  command,
  transfer,
  membership,
  facts,
  team,
} from './fixture.js';

export function registerSwapsOwnerAdminOneCommit(): void {
  it('swaps owner and admin in one commit and keeps exactly one owner', async () => {
    const { owner, workspaceId, members } = await team('builder', 'viewer');
    const [builder = '', viewer = ''] = members;
    await database.sessions(owner);
    await database.sessions(builder);
    const handover = {
      ...transfer(workspaceId, owner, builder),
      traceId: 'transfer-trace',
    };

    await expect(
      database.identity().transferWorkspaceOwnership(handover),
    ).resolves.toEqual({
      ownerUserId: builder,
      ownerRoleRevision: 2,
      previousOwnerUserId: owner,
      previousOwnerRoleRevision: 2,
      replayed: false,
    });
    await expect(membership(workspaceId, builder)).resolves.toEqual({
      status: 'active',
      role: 'owner',
      role_revision: 2,
    });
    await expect(membership(workspaceId, owner)).resolves.toEqual({
      status: 'active',
      role: 'admin',
      role_revision: 2,
    });
    for (const person of [owner, builder])
      await expect(database.liveSessions(person)).resolves.toBe(0);
    await expect(
      database.identity().transferWorkspaceOwnership(handover),
    ).resolves.toMatchObject({ replayed: true, ownerUserId: builder });
    await expect(
      database
        .identity()
        .transferWorkspaceOwnership(
          transfer(workspaceId, owner, viewer, { owner: 2 }),
        ),
    ).rejects.toMatchObject({ reason: 'command_forbidden' });
    await expect(
      facts(workspaceId, 'workspace.ownership_transferred'),
    ).resolves.toEqual([
      {
        actor_user_id: owner,
        target_id: builder,
        metadata: {
          fromRole: 'builder',
          previousOwnerFromRevision: 1,
          previousOwnerToRevision: 2,
          fromRevision: 1,
          toRevision: 2,
        },
      },
    ]);
    // The previous owner, now an admin, may leave; the new owner may not.
    await expect(
      database.identity().leaveWorkspace({
        workspaceId,
        actorUserId: owner,
        idempotencyKey: randomUUID(),
      }),
    ).resolves.toMatchObject({ roleRevision: 3 });
    await expect(
      database.identity().leaveWorkspace({
        workspaceId,
        actorUserId: builder,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'owner_departure' });
  });

  it('refuses inactive targets, stale revisions and self transfers', async () => {
    const { owner, workspaceId, members } = await team('admin', 'builder');
    const [admin = '', builder = ''] = members;
    await database
      .identity()
      .suspendWorkspaceMember(command(workspaceId, owner, builder));
    const attempt = (input: ReturnType<typeof transfer>) =>
      database.identity().transferWorkspaceOwnership(input);

    for (const [input, reason] of [
      [transfer(workspaceId, owner, builder, { target: 2 }), 'target_inactive'],
      [transfer(workspaceId, owner, owner), 'self_command'],
      [
        transfer(workspaceId, admin, builder, { target: 2 }),
        'command_forbidden',
      ],
      [transfer(workspaceId, owner, admin, { target: 2 }), 'revision_conflict'],
      [transfer(workspaceId, owner, admin, { owner: 2 }), 'revision_conflict'],
      [transfer(workspaceId, owner, randomUUID()), 'target_missing'],
    ] as const)
      await expect(attempt(input)).rejects.toMatchObject({ reason });
    await expect(membership(workspaceId, owner)).resolves.toMatchObject({
      role: 'owner',
      role_revision: 1,
    });
  });

  it('lets one of two concurrent transfers win', async () => {
    const { owner, workspaceId, members } = await team('admin', 'builder');
    const [admin = '', builder = ''] = members;
    const outcomes = await Promise.allSettled([
      database
        .identity()
        .transferWorkspaceOwnership(transfer(workspaceId, owner, admin)),
      database
        .identity()
        .transferWorkspaceOwnership(transfer(workspaceId, owner, builder)),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    if (rejected?.status !== 'rejected')
      throw new Error('One concurrent transfer should have failed');
    expect(['revision_conflict', 'command_forbidden']).toContain(
      (rejected.reason as { reason: string }).reason,
    );
    const owners = await database.asAdmin<{ count: number }>(
      `select count(*)::int count from app.workspace_memberships
        where workspace_id=$1 and role='owner' and status<>'removed'`,
      [workspaceId],
    );
    expect(owners).toEqual([{ count: 1 }]);
  });
}
