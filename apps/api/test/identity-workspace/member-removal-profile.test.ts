import {
  UserProfileCommandConflictError,
  WorkspaceMemberRemovalCommandConflictError,
  type IdentityWorkspaceDatabase,
} from '@pertexo/database/api';
import { describe, expect, it, vi } from 'vitest';

import {
  DatabaseIdentityWorkspaceAdapter,
  GetCurrentUserUseCase,
  ListWorkspaceMembersUseCase,
  RemoveWorkspaceMemberUseCase,
  UpdateUserProfileUseCase,
  UserController,
  WorkspaceMembersController,
  mapIdentityWorkspaceError,
  type ChangeWorkspaceMemberRoleUseCase,
  type CookieResponse,
} from '../../src/identity-workspace/index.js';
import {
  memberRemovalPersistence,
  profilePersistence,
} from '../../src/identity-workspace/persistence-capabilities.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const targetId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const at = new Date('2026-09-24T10:00:00.000Z');

function request(idempotencyKey = 'member-command-1') {
  return {
    requestId: 'request-removal',
    traceId: 'trace-removal',
    headers: { 'idempotency-key': idempotencyKey },
    identitySession: {
      userId: actorId,
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      expiresAt: new Date('2026-09-25T00:00:00.000Z'),
      clientMetadata: {},
    },
  } as const;
}

function profile(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: actorId,
    email: 'person@example.test',
    displayName: 'Ada Lovelace',
    status: 'active' as const,
    profileRevision: 2,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe('member removal and self profile commands', () => {
  it('forwards one strict member removal at the revision the actor saw', async () => {
    const removeWorkspaceMember = vi.fn().mockResolvedValue({
      userId: targetId,
      roleRevision: 4,
      replayed: false,
    });
    const controller = new WorkspaceMembersController(
      new ListWorkspaceMembersUseCase(
        { listWorkspaceMembers: vi.fn() },
        { findAccess: vi.fn() },
      ),
      { execute: vi.fn() } as unknown as ChangeWorkspaceMemberRoleUseCase,
      new RemoveWorkspaceMemberUseCase({ removeWorkspaceMember }),
    );

    await expect(
      controller.remove(
        request(),
        { workspaceId, userId: targetId },
        { expectedRoleRevision: 3 },
      ),
    ).resolves.toEqual({ userId: targetId, roleRevision: 4, replayed: false });
    expect(removeWorkspaceMember).toHaveBeenCalledWith({
      workspaceId,
      actorUserId: actorId,
      targetUserId: targetId,
      expectedRoleRevision: 3,
      idempotencyKey: 'member-command-1',
      requestId: 'request-removal',
      traceId: 'trace-removal',
    });
    for (const body of [{ expectedRoleRevision: 0 }, { role: 'viewer' }])
      await expect(
        controller.remove(request(), { workspaceId, userId: targetId }, body),
      ).rejects.toMatchObject({ name: 'ZodError' });
    expect(removeWorkspaceMember).toHaveBeenCalledOnce();
  });

  it('changes the signed-in display name and projects the receipt', async () => {
    const updateUserProfile = vi.fn().mockResolvedValue({
      user: profile({ displayName: 'Grace Hopper', profileRevision: 3 }),
      changed: true,
      replayed: false,
    });
    const response: CookieResponse = { header: vi.fn() };
    const controller = new UserController(
      new GetCurrentUserUseCase({ findUserById: vi.fn() }),
      new UpdateUserProfileUseCase({ updateUserProfile }),
    );

    await expect(
      controller.updateMe(
        request('profile-command-1'),
        { displayName: '  Grace Hopper ', expectedRevision: 2 },
        response,
      ),
    ).resolves.toEqual({
      profile: {
        id: actorId,
        email: 'person@example.test',
        displayName: 'Grace Hopper',
        status: 'active',
        revision: 3,
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
      },
      changed: true,
      replayed: false,
    });
    expect(updateUserProfile).toHaveBeenCalledWith({
      actorUserId: actorId,
      displayName: 'Grace Hopper',
      expectedRevision: 2,
      idempotencyKey: 'profile-command-1',
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(response.header)).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    for (const displayName of ['', 'x'.repeat(129), 'Tab\tName'])
      await expect(
        controller.updateMe(
          request(),
          { displayName, expectedRevision: 2 },
          response,
        ),
      ).rejects.toMatchObject({ name: 'ZodError' });
  });

  it.each([
    ['target_missing', 'resource.not_found'],
    ['revision_conflict', 'workspace.member_role_revision_conflict'],
    ['idempotency_conflict', 'request.idempotency_conflict'],
    ['target_inactive', 'workspace.member_removal_conflict'],
    ['self_removal', 'auth.forbidden'],
    ['owner_removal', 'auth.forbidden'],
    ['removal_forbidden', 'auth.forbidden'],
    ['actor_inactive', 'auth.forbidden'],
  ] as const)('maps removal %s to %s', (reason, code) => {
    expect(
      mapIdentityWorkspaceError(
        new WorkspaceMemberRemovalCommandConflictError(reason, 'unsafe detail'),
      ),
    ).toMatchObject({ code });
  });

  it.each([
    ['revision_conflict', 'user.profile_revision_conflict'],
    ['idempotency_conflict', 'request.idempotency_conflict'],
    ['user_inactive', 'auth.unauthenticated'],
  ] as const)('maps profile %s to %s', (reason, code) => {
    expect(
      mapIdentityWorkspaceError(
        new UserProfileCommandConflictError(reason, 'unsafe detail'),
      ),
    ).toMatchObject({ code });
  });

  it('fails closed when an optional command is not configured', async () => {
    await expect(
      memberRemovalPersistence({} as never).removeWorkspaceMember({
        workspaceId,
        actorUserId: actorId,
        targetUserId: targetId,
        expectedRoleRevision: 1,
        idempotencyKey: 'key',
      }),
    ).rejects.toThrow('Workspace member removal persistence is not configured');
    await expect(
      profilePersistence({} as never).updateUserProfile({
        actorUserId: actorId,
        displayName: 'Name',
        expectedRevision: 1,
        idempotencyKey: 'key',
      }),
    ).rejects.toThrow('User profile persistence is not configured');
    const removeWorkspaceMember = vi.fn().mockResolvedValue({});
    const updateUserProfile = vi.fn().mockResolvedValue({});
    await memberRemovalPersistence({
      removeWorkspaceMember,
    } as never).removeWorkspaceMember({} as never);
    await profilePersistence({ updateUserProfile } as never).updateUserProfile(
      {} as never,
    );
    expect(removeWorkspaceMember).toHaveBeenCalledOnce();
    expect(updateUserProfile).toHaveBeenCalledOnce();
  });

  it('adapts the database commands without leaking database records', async () => {
    const database = {
      removeWorkspaceMember: vi.fn().mockResolvedValue({
        userId: targetId,
        roleRevision: 2,
        replayed: true,
      }),
      updateUserProfile: vi.fn().mockResolvedValue({
        user: { ...profile(), internal: 'not projected' },
        changed: false,
        replayed: true,
      }),
    } as unknown as IdentityWorkspaceDatabase;
    const adapter = new DatabaseIdentityWorkspaceAdapter(database);
    const removal = {
      workspaceId,
      actorUserId: actorId,
      targetUserId: targetId,
      expectedRoleRevision: 1,
      idempotencyKey: 'key',
    };

    await expect(adapter.removeWorkspaceMember(removal)).resolves.toEqual({
      userId: targetId,
      roleRevision: 2,
      replayed: true,
    });
    await expect(
      adapter.updateUserProfile({
        actorUserId: actorId,
        displayName: 'Ada Lovelace',
        expectedRevision: 2,
        idempotencyKey: 'key',
      }),
    ).resolves.toEqual({ user: profile(), changed: false, replayed: true });
  });
});
