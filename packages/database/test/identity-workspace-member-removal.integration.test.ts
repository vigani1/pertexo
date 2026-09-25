import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { WorkspaceMemberRemovalCommandConflictError } from '../src/testing.js';
import { useIdentityCommandDatabase } from './support/identity-command.integration.support.js';

const database = useIdentityCommandDatabase('member_removal');

function removal(
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
    idempotencyKey: `remove-${randomUUID()}`,
  };
}

async function removedFacts(workspaceId: string) {
  return database.asAdmin<{ metadata: Record<string, unknown> }>(
    `select metadata from app.audit_events
      where workspace_id=$1 and action='workspace.member_removed'`,
    [workspaceId],
  );
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

describe('workspace member removal (ADR 042)', () => {
  it('removes a member once, ends their sessions and replays the exact command', async () => {
    const owner = await database.user('Removal owner');
    const target = await database.user('Removal target');
    const workspaceId = await database.workspace(owner.id);
    await database.member(workspaceId, target.id, 'viewer');
    await database.sessions(target.id);
    const command = {
      ...removal(workspaceId, owner.id, target.id),
      requestId: 'removal-request',
      traceId: 'removal-trace',
    };

    await expect(
      database.identity().removeWorkspaceMember(command),
    ).resolves.toEqual({ userId: target.id, roleRevision: 2, replayed: false });
    await expect(database.liveSessions(target.id)).resolves.toEqual({
      opaque: 0,
      betterAuth: 0,
    });
    await expect(membership(workspaceId, target.id)).resolves.toEqual({
      status: 'removed',
      role: 'viewer',
      role_revision: 2,
    });
    await expect(
      database.identity().findWorkspaceAccess(target.id, workspaceId),
    ).resolves.toMatchObject({ membershipStatus: 'removed' });
    const listed = await database
      .identity()
      .listWorkspaceMembers(workspaceId, owner.id);
    expect(listed.items.map((item) => item.userId)).not.toContain(target.id);
    await expect(
      database.identity().listAccessibleWorkspaces(target.id),
    ).resolves.toMatchObject({ items: [] });

    await expect(
      database.identity().removeWorkspaceMember(command),
    ).resolves.toEqual({ userId: target.id, roleRevision: 2, replayed: true });
    await expect(
      database
        .identity()
        .removeWorkspaceMember({ ...command, expectedRoleRevision: 2 }),
    ).rejects.toMatchObject({ reason: 'idempotency_conflict' });
    await expect(
      database
        .identity()
        .removeWorkspaceMember(removal(workspaceId, owner.id, target.id, 2)),
    ).rejects.toMatchObject({ reason: 'target_inactive' });
    await expect(removedFacts(workspaceId)).resolves.toEqual([
      {
        metadata: {
          role: 'viewer',
          fromStatus: 'active',
          fromRevision: 1,
          toRevision: 2,
        },
      },
    ]);
  });

  it('allows owners any non-owner and admins only operational roles', async () => {
    const owner = await database.user('Matrix owner');
    const admin = await database.user('Matrix admin');
    const peer = await database.user('Matrix peer admin');
    const builder = await database.user('Matrix builder');
    const operator = await database.user('Matrix operator');
    const viewer = await database.user('Matrix viewer');
    const workspaceId = await database.workspace(owner.id);
    await database.member(workspaceId, admin.id, 'admin');
    await database.member(workspaceId, peer.id, 'admin');
    await database.member(workspaceId, builder.id, 'builder');
    await database.member(workspaceId, operator.id, 'operator');
    await database.member(workspaceId, viewer.id, 'viewer');
    const remove = (input: ReturnType<typeof removal>) =>
      database.identity().removeWorkspaceMember(input);

    for (const [actor, target, reason] of [
      [admin.id, peer.id, 'removal_forbidden'],
      [admin.id, owner.id, 'owner_removal'],
      [admin.id, admin.id, 'self_removal'],
      [owner.id, owner.id, 'self_removal'],
      [builder.id, viewer.id, 'actor_inactive'],
      [owner.id, randomUUID(), 'target_missing'],
    ] as const)
      await expect(
        remove(removal(workspaceId, actor, target)),
      ).rejects.toMatchObject({ reason });

    for (const target of [builder.id, operator.id, viewer.id])
      await expect(
        remove(removal(workspaceId, admin.id, target)),
      ).resolves.toMatchObject({ roleRevision: 2 });
    await expect(
      remove(removal(workspaceId, owner.id, peer.id)),
    ).resolves.toMatchObject({ roleRevision: 2 });
    await expect(
      remove(removal(workspaceId, peer.id, viewer.id)),
    ).rejects.toMatchObject({ reason: 'actor_inactive' });
  });

  it('fences stale removals by role revision and serializes same-revision commands', async () => {
    const owner = await database.user('Revision owner');
    const target = await database.user('Revision target');
    const workspaceId = await database.workspace(owner.id);
    await database.member(workspaceId, target.id, 'viewer');
    await database.identity().changeWorkspaceMemberRole({
      workspaceId,
      actorUserId: owner.id,
      targetUserId: target.id,
      role: 'builder',
      expectedRoleRevision: 1,
      idempotencyKey: randomUUID(),
    });
    const stale = database
      .identity()
      .removeWorkspaceMember(removal(workspaceId, owner.id, target.id, 1));
    await expect(stale).rejects.toBeInstanceOf(
      WorkspaceMemberRemovalCommandConflictError,
    );
    await expect(stale).rejects.toMatchObject({ reason: 'revision_conflict' });

    const outcomes = await Promise.allSettled([
      database
        .identity()
        .removeWorkspaceMember(removal(workspaceId, owner.id, target.id, 2)),
      database.identity().changeWorkspaceMemberRole({
        workspaceId,
        actorUserId: owner.id,
        targetUserId: target.id,
        role: 'operator',
        expectedRoleRevision: 2,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    if (rejected?.status !== 'rejected')
      throw new Error('One same-revision member command should have failed');
    expect(['revision_conflict', 'target_inactive']).toContain(
      (rejected.reason as { reason: string }).reason,
    );
    await expect(membership(workspaceId, target.id)).resolves.toMatchObject({
      role_revision: 3,
    });
  });

  it('coalesces concurrent duplicates and rolls back every write on a late failure', async () => {
    const owner = await database.user('Duplicate owner');
    const target = await database.user('Duplicate target');
    const workspaceId = await database.workspace(owner.id);
    await database.member(workspaceId, target.id, 'operator');
    await database.sessions(target.id);
    const failing = {
      ...removal(workspaceId, owner.id, target.id),
      requestId: 'x'.repeat(129),
    };
    await expect(
      database.identity().removeWorkspaceMember(failing),
    ).rejects.toBeDefined();
    await expect(membership(workspaceId, target.id)).resolves.toMatchObject({
      status: 'active',
      role_revision: 1,
    });
    await expect(database.liveSessions(target.id)).resolves.toEqual({
      opaque: 1,
      betterAuth: 1,
    });

    const command = removal(workspaceId, owner.id, target.id);
    const receipts = await Promise.all([
      database.identity().removeWorkspaceMember(command),
      database.identity().removeWorkspaceMember(command),
    ]);
    expect(receipts.map((receipt) => receipt.replayed).sort()).toEqual([
      false,
      true,
    ]);
    await expect(removedFacts(workspaceId)).resolves.toHaveLength(1);
    // Request and trace identifiers describe a delivery, not the command.
    await expect(
      database.identity().removeWorkspaceMember({
        ...failing,
        idempotencyKey: command.idempotencyKey,
      }),
    ).resolves.toMatchObject({ replayed: true, roleRevision: 2 });
  });

  it('keeps pending invitations the removed admin created', async () => {
    const owner = await database.user('Invitation owner');
    const admin = await database.user('Inviting admin');
    const workspaceId = await database.workspace(owner.id);
    await database.member(workspaceId, admin.id, 'admin');
    const invited = await database.identity().createWorkspaceInvitation({
      ...invitation(workspaceId, admin.id, `${randomUUID()}@example.test`),
    });
    await database
      .identity()
      .removeWorkspaceMember(removal(workspaceId, owner.id, admin.id));
    const pending = await database
      .identity()
      .listWorkspaceInvitations(workspaceId, owner.id);
    expect(pending.items).toEqual([
      expect.objectContaining({
        id: invited.invitation.id,
        status: 'pending',
        revision: 1,
      }),
    ]);
  });

  it('lets a removed member rejoin through a later invitation, but never a suspended one', async () => {
    const owner = await database.user('Rejoin owner');
    const returning = await database.user('Returning member');
    const workspaceId = await database.workspace(owner.id);
    await database.member(workspaceId, returning.id, 'builder');
    await database
      .identity()
      .removeWorkspaceMember(removal(workspaceId, owner.id, returning.id));

    await expect(
      acceptInvitation(workspaceId, owner.id, returning),
    ).resolves.toMatchObject({ membershipCreated: true, role: 'viewer' });
    await expect(membership(workspaceId, returning.id)).resolves.toEqual({
      status: 'active',
      role: 'viewer',
      role_revision: 3,
    });

    await database.asAdmin(
      `update app.workspace_memberships set status='suspended'
        where workspace_id=$1 and user_id=$2`,
      [workspaceId, returning.id],
    );
    await expect(
      acceptInvitation(workspaceId, owner.id, returning),
    ).rejects.toMatchObject({ reason: 'member_inactive' });
  });
});

function invitation(workspaceId: string, actorUserId: string, email: string) {
  return {
    workspaceId,
    actorUserId,
    email,
    role: 'viewer' as const,
    idempotencyKey: randomUUID(),
    tokenDigest: createHash('sha256').update(randomUUID()).digest('hex'),
    sealedToken: {
      ciphertext: 'sealed-token',
      nonce: 'nonce',
      tag: 'tag',
      keyVersion: 'test-v1',
    },
    expiresAt: new Date(Date.now() + 60 * 60_000),
  };
}

async function acceptInvitation(
  workspaceId: string,
  ownerUserId: string,
  recipient: Readonly<{ id: string; email: string }>,
) {
  const identity = database.identity();
  const command = invitation(workspaceId, ownerUserId, recipient.email);
  const created = await identity.createWorkspaceInvitation(command);
  const intentId = randomUUID();
  const bindingDigest = createHash('sha256').update(randomUUID()).digest('hex');
  await identity.resolveInvitationAcceptance({
    workspaceId,
    invitationId: created.invitation.id,
    tokenDigest: command.tokenDigest,
    intentId,
    bindingDigest,
    csrfDigest: createHash('sha256').update(randomUUID()).digest('hex'),
    expiresAt: new Date(Date.now() + 15 * 60_000),
  });
  await identity.recordInvitationAcceptanceProof({
    workspaceId,
    intentId,
    bindingDigest,
    userId: recipient.id,
    verifiedEmail: recipient.email,
    verifiedAt: new Date(),
  });
  return identity.completeInvitationAcceptance({
    workspaceId,
    intentId,
    invitationRevision: 1,
    actorUserId: recipient.id,
    idempotencyKey: randomUUID(),
    replacementSession: {
      authority: 'better_auth',
      id: randomUUID(),
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
}
