import {
  WorkspaceMembershipCommandConflictError,
  type IdentityWorkspaceDatabase,
} from '@pertexo/database/api';
import { describe, expect, it, vi } from 'vitest';

import { IdentityError } from '../../src/identity/index.js';
import {
  DatabaseIdentityWorkspaceAdapter,
  WorkspaceMembershipController,
  WorkspaceMembershipLifecycleUseCase,
  mapIdentityWorkspaceError,
  type IdentitySessionAuthority,
} from '../../src/identity-workspace/index.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const targetId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const now = new Date('2026-09-25T10:00:00.000Z');

function request(idempotencyKey = 'membership-command-1') {
  return {
    requestId: 'request-membership',
    traceId: 'trace-membership',
    headers: {
      'idempotency-key': idempotencyKey,
      cookie: 'pertexo_session=session-cookie',
    },
    identitySession: {
      userId: actorId,
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      expiresAt: new Date('2026-09-26T00:00:00.000Z'),
      clientMetadata: {},
    },
  } as const;
}

function persistence() {
  return {
    leaveWorkspace: vi
      .fn()
      .mockResolvedValue({ userId: actorId, roleRevision: 2, replayed: false }),
    suspendWorkspaceMember: vi.fn().mockResolvedValue({
      userId: targetId,
      roleRevision: 4,
      membershipStatus: 'suspended',
      replayed: false,
    }),
    reactivateWorkspaceMember: vi.fn().mockResolvedValue({
      userId: targetId,
      roleRevision: 5,
      membershipStatus: 'active',
      replayed: true,
    }),
    transferWorkspaceOwnership: vi.fn().mockResolvedValue({
      ownerUserId: targetId,
      ownerRoleRevision: 3,
      previousOwnerUserId: actorId,
      previousOwnerRoleRevision: 2,
      replayed: false,
    }),
  };
}

function controller(
  store = persistence(),
  signedInAt: Date | 'no evidence' = new Date(now.getTime() - 60_000),
  evidenceUserId = actorId,
) {
  const sessions = {
    ...(signedInAt === 'no evidence'
      ? {}
      : {
          signInEvidence: vi.fn().mockResolvedValue({
            userId: evidenceUserId,
            email: 'owner@example.test',
            emailVerified: true,
            signedInAt,
          }),
        }),
  } as unknown as IdentitySessionAuthority;
  return new WorkspaceMembershipController(
    new WorkspaceMembershipLifecycleUseCase(store, { now: () => now }),
    sessions,
  );
}

const delivery = {
  workspaceId,
  actorUserId: actorId,
  idempotencyKey: 'membership-command-1',
  requestId: 'request-membership',
  traceId: 'trace-membership',
};

describe('membership lifecycle commands (ADR 047)', () => {
  it('leaves the route workspace as the signed-in actor with a strict empty body', async () => {
    const store = persistence();
    const membership = controller(store);

    await expect(
      membership.leave(request(), { workspaceId }, {}),
    ).resolves.toEqual({ userId: actorId, roleRevision: 2, replayed: false });
    expect(store.leaveWorkspace).toHaveBeenCalledWith(delivery);
    await expect(
      membership.leave(request(), { workspaceId }, { expectedRoleRevision: 1 }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(store.leaveWorkspace).toHaveBeenCalledOnce();
  });

  it('suspends and reactivates at the revision the manager saw', async () => {
    const store = persistence();
    const membership = controller(store);
    const params = { workspaceId, userId: targetId };

    await expect(
      membership.suspend(request(), params, { expectedRoleRevision: 3 }),
    ).resolves.toMatchObject({ membershipStatus: 'suspended' });
    await expect(
      membership.reactivate(request(), params, { expectedRoleRevision: 4 }),
    ).resolves.toMatchObject({ membershipStatus: 'active', replayed: true });
    expect(store.suspendWorkspaceMember).toHaveBeenCalledWith({
      ...delivery,
      targetUserId: targetId,
      expectedRoleRevision: 3,
    });
    expect(store.reactivateWorkspaceMember).toHaveBeenCalledWith({
      ...delivery,
      targetUserId: targetId,
      expectedRoleRevision: 4,
    });
    for (const body of [{}, { expectedRoleRevision: 1, status: 'active' }])
      await expect(
        membership.suspend(request(), params, body),
      ).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('transfers ownership only from a sign-in in the last five minutes', async () => {
    const store = persistence();
    const params = { workspaceId, userId: targetId };
    const body = { expectedRoleRevision: 2, expectedOwnerRoleRevision: 1 };

    await expect(
      controller(store).transferOwnership(request(), params, body),
    ).resolves.toMatchObject({ ownerUserId: targetId, replayed: false });
    expect(store.transferWorkspaceOwnership).toHaveBeenCalledWith({
      ...delivery,
      targetUserId: targetId,
      expectedRoleRevision: 2,
      expectedOwnerRoleRevision: 1,
    });

    const stale = controller(
      store,
      new Date(now.getTime() - 5 * 60_000 - 1),
    ).transferOwnership(request(), params, body);
    await expect(stale).rejects.toBeInstanceOf(IdentityError);
    await expect(stale).rejects.toMatchObject({
      code: 'identity.session_not_fresh',
      status: 403,
    });
    await expect(
      controller(store, 'no evidence').transferOwnership(
        request(),
        params,
        body,
      ),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    await expect(
      controller(store, now, targetId).transferOwnership(
        request(),
        params,
        body,
      ),
    ).rejects.toMatchObject({ code: 'auth.unauthenticated' });
    await expect(
      controller(store).transferOwnership(request(), params, {
        expectedRoleRevision: 2,
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(store.transferWorkspaceOwnership).toHaveBeenCalledOnce();
  });

  it.each([
    ['target_missing', 'resource.not_found'],
    ['revision_conflict', 'workspace.member_role_revision_conflict'],
    ['idempotency_conflict', 'request.idempotency_conflict'],
    ['target_removed', 'workspace.member_removal_conflict'],
    ['target_inactive', 'workspace.member_status_conflict'],
    ['owner_departure', 'auth.forbidden'],
    ['self_command', 'auth.forbidden'],
    ['owner_target', 'auth.forbidden'],
    ['command_forbidden', 'auth.forbidden'],
    ['actor_inactive', 'auth.forbidden'],
  ] as const)('maps %s to %s', (reason, code) => {
    expect(
      mapIdentityWorkspaceError(
        new WorkspaceMembershipCommandConflictError(reason, 'unsafe detail'),
      ),
    ).toMatchObject({ code });
  });

  it('asks for a fresh sign-in in its own words', () => {
    expect(
      mapIdentityWorkspaceError(
        new IdentityError('identity.session_not_fresh'),
      ),
    ).toMatchObject({
      code: 'auth.session_not_fresh',
      safeDetail: 'Sign in again, then retry within five minutes.',
    });
  });

  it('passes each command to the database unchanged', async () => {
    const store = persistence();
    const adapter = new DatabaseIdentityWorkspaceAdapter(
      store as unknown as IdentityWorkspaceDatabase,
    );
    const member = {
      ...delivery,
      targetUserId: targetId,
      expectedRoleRevision: 1,
    };

    await adapter.leaveWorkspace(delivery);
    await adapter.suspendWorkspaceMember(member);
    await adapter.reactivateWorkspaceMember(member);
    await adapter.transferWorkspaceOwnership({
      ...member,
      expectedOwnerRoleRevision: 1,
    });
    expect(store.leaveWorkspace).toHaveBeenCalledWith(delivery);
    expect(store.suspendWorkspaceMember).toHaveBeenCalledWith(member);
    expect(store.reactivateWorkspaceMember).toHaveBeenCalledWith(member);
    expect(store.transferWorkspaceOwnership).toHaveBeenCalledWith({
      ...member,
      expectedOwnerRoleRevision: 1,
    });
  });
});
