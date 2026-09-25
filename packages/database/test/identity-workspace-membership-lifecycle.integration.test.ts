import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { WorkspaceMembershipCommandConflictError } from '../src/testing.js';
import { useIdentityCommandDatabase } from './support/identity-command.integration.support.js';

const database = useIdentityCommandDatabase('membership');

function command(
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
  expectedRoleRevision = 1,
) {
  return {
    workspaceId,
    actorUserId,
    targetUserId,
    expectedRoleRevision,
    idempotencyKey: `member-${randomUUID()}`,
  };
}

function transfer(
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
  revisions: Readonly<{ target?: number; owner?: number }> = {},
) {
  return {
    ...command(workspaceId, actorUserId, targetUserId, revisions.target),
    expectedOwnerRoleRevision: revisions.owner ?? 1,
  };
}

async function membership(workspaceId: string, userId: string) {
  const rows = await database.asAdmin<{
    status: string;
    role: string;
    role_revision: number;
  }>(
    `select status,role,role_revision from app.workspace_memberships
      where workspace_id=$1 and user_id=$2`,
    [workspaceId, userId],
  );
  return rows[0];
}

async function facts(workspaceId: string, action: string) {
  return database.asAdmin<{
    actor_user_id: string;
    target_id: string;
    metadata: Record<string, unknown>;
  }>(
    `select actor_user_id,target_id,metadata from app.audit_events
      where workspace_id=$1 and action=$2 order by occurred_at`,
    [workspaceId, action],
  );
}

async function team(...roles: readonly ('admin' | 'builder' | 'viewer')[]) {
  const owner = await database.user('Lifecycle owner');
  const workspaceId = await database.workspace(owner.id);
  const members = [];
  for (const role of roles) {
    const person = await database.user(`Lifecycle ${role}`);
    await database.member(workspaceId, person.id, role);
    members.push(person.id);
  }
  return { owner: owner.id, workspaceId, members };
}

describe('leaving a workspace (ADR 047)', () => {
  it('ends the membership and every session like a removal, and replays exactly', async () => {
    const { owner, workspaceId, members } = await team('builder');
    const [leaver = ''] = members;
    await database.sessions(leaver);
    const leave = {
      workspaceId,
      actorUserId: leaver,
      idempotencyKey: `leave-${randomUUID()}`,
      requestId: 'leave-request',
    };

    await expect(database.identity().leaveWorkspace(leave)).resolves.toEqual({
      userId: leaver,
      roleRevision: 2,
      replayed: false,
    });
    await expect(membership(workspaceId, leaver)).resolves.toEqual({
      status: 'removed',
      role: 'builder',
      role_revision: 2,
    });
    await expect(database.liveSessions(leaver)).resolves.toEqual({
      opaque: 0,
      betterAuth: 0,
    });
    await expect(
      database.identity().listAccessibleWorkspaces(leaver),
    ).resolves.toMatchObject({ items: [] });
    await expect(database.identity().leaveWorkspace(leave)).resolves.toEqual({
      userId: leaver,
      roleRevision: 2,
      replayed: true,
    });
    await expect(
      database
        .identity()
        .leaveWorkspace({ ...leave, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ reason: 'actor_inactive' });
    await expect(facts(workspaceId, 'workspace.member_left')).resolves.toEqual([
      {
        actor_user_id: leaver,
        target_id: leaver,
        metadata: { role: 'builder', fromRevision: 1, toRevision: 2 },
      },
    ]);

    const refusal = database.identity().leaveWorkspace({
      workspaceId,
      actorUserId: owner,
      idempotencyKey: randomUUID(),
    });
    await expect(refusal).rejects.toBeInstanceOf(
      WorkspaceMembershipCommandConflictError,
    );
    await expect(refusal).rejects.toMatchObject({ reason: 'owner_departure' });
    await expect(
      database.identity().leaveWorkspace({
        workspaceId,
        actorUserId: (await database.user('Stranger')).id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'actor_inactive' });
  });

  it('coalesces concurrent duplicates and rolls back a late failure', async () => {
    const { workspaceId, members } = await team('viewer');
    const [leaver = ''] = members;
    await database.sessions(leaver);
    const failing = {
      workspaceId,
      actorUserId: leaver,
      idempotencyKey: randomUUID(),
      requestId: 'x'.repeat(129),
    };
    await expect(
      database.identity().leaveWorkspace(failing),
    ).rejects.toBeDefined();
    await expect(membership(workspaceId, leaver)).resolves.toMatchObject({
      status: 'active',
      role_revision: 1,
    });
    await expect(database.liveSessions(leaver)).resolves.toEqual({
      opaque: 1,
      betterAuth: 1,
    });

    const leave = { workspaceId, actorUserId: leaver, idempotencyKey: 'once' };
    const receipts = await Promise.all([
      database.identity().leaveWorkspace(leave),
      database.identity().leaveWorkspace(leave),
    ]);
    expect(receipts.map((receipt) => receipt.replayed).sort()).toEqual([
      false,
      true,
    ]);
    await expect(
      facts(workspaceId, 'workspace.member_left'),
    ).resolves.toHaveLength(1);
  });
});

describe('suspending and reactivating members (ADR 047)', () => {
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
    await expect(database.liveSessions(builder)).resolves.toEqual({
      opaque: 0,
      betterAuth: 0,
    });
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
    await expect(database.liveSessions(builder)).resolves.toEqual({
      opaque: 0,
      betterAuth: 0,
    });
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
});

describe('transferring ownership (ADR 047)', () => {
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
      await expect(database.liveSessions(person)).resolves.toEqual({
        opaque: 0,
        betterAuth: 0,
      });
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
});
