import { InvalidWorkspaceMemberCursorError } from '../../../src/workspaces/cursor.js';
import { expect, it, vi } from 'vitest';

import {
  ChangeWorkspaceMemberRoleUseCase,
  GetCurrentUserUseCase,
  ListAccessibleWorkspacesUseCase,
  ListWorkspaceMembersUseCase,
} from '../../../src/workspaces/index.js';
import { encodeWorkspaceMemberCursor } from '../../../src/workspaces/index.js';

import type { WorkspaceAuthorizationReader } from '../../../src/workspaces/ports.js';

import {
  actorId,
  workspaceId,
  requestId,
  idempotencyKey,
  workspace,
  user,
  persistence,
  activeAccess,
  actor,
} from './fixture.js';

export function registerValidatesForwardsExactMemberRoleCommand(): void {
  it('validates and forwards the exact member role command', async () => {
    const store = persistence();
    const targetUserId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await expect(
      new ChangeWorkspaceMemberRoleUseCase(store).execute({
        actor: actor(),
        routeWorkspaceId: workspaceId,
        targetUserId,
        request: { role: 'operator', expectedRoleRevision: 1 },
        idempotencyKey,
        requestId,
        traceId: 'trace-42',
      }),
    ).resolves.toEqual({
      userId: targetUserId,
      role: 'operator',
      roleRevision: 2,
      changed: true,
      replayed: false,
    });
    expect(store.changeWorkspaceMemberRole).toHaveBeenCalledWith({
      workspaceId,
      actorUserId: actorId,
      targetUserId,
      role: 'operator',
      expectedRoleRevision: 1,
      idempotencyKey,
      requestId,
      traceId: 'trace-42',
    });
  });

  it('returns only the allowlisted current-user profile fields', async () => {
    const store = persistence();
    vi.mocked(store.findUserById).mockResolvedValue(user());
    const result = await new GetCurrentUserUseCase(store).execute(actorId);
    expect(result).toEqual({
      id: actorId,
      email: 'person@example.test',
      displayName: 'Person',
      status: 'active',
      revision: 3,
      createdAt: '2026-08-20T12:00:00.000Z',
      updatedAt: '2026-08-20T12:00:00.000Z',
    });
  });

  it.each([
    ['missing', null],
    ['suspended', { ...user(), status: 'suspended' as const }],
  ])('rejects a %s current user as unauthenticated', async (_case, profile) => {
    const store = persistence();
    vi.mocked(store.findUserById).mockResolvedValue(profile);

    await expect(
      new GetCurrentUserUseCase(store).execute(actorId),
    ).rejects.toMatchObject({ code: 'auth.unauthenticated' });
  });

  it('projects accessible workspaces with server-owned role capabilities', async () => {
    const store = persistence();
    vi.mocked(store.listAccessibleWorkspaces).mockResolvedValue({
      items: [{ ...workspace(), revision: 1, role: 'builder' }],
      nextCursor: workspaceId,
    });

    const result = await new ListAccessibleWorkspacesUseCase(store).execute(
      actorId,
      { limit: 1 },
    );

    expect(result).toMatchObject({
      items: [
        {
          ...workspace(),
          revision: 1,
          role: 'builder',
          createdAt: '2026-08-20T12:00:00.000Z',
          updatedAt: '2026-08-20T12:00:00.000Z',
        },
      ],
      nextCursor: workspaceId,
    });
    expect(result.items[0]?.capabilities).toEqual(
      expect.arrayContaining([
        'workspace:read',
        'workflow:create',
        'workflow:update',
      ]),
    );
    expect(store.listAccessibleWorkspaces).toHaveBeenCalledWith(actorId, {
      limit: 1,
    });
  });

  it('authorizes and passes an opaque member cursor to the bounded persistence page', async () => {
    const store = persistence();
    const member = {
      userId: actorId,
      email: 'person@example.test',
      displayName: 'Person',
      role: 'admin' as const,
      roleRevision: 1,
      membershipStatus: 'active' as const,
      createdAt: new Date('2026-08-20T12:00:00.000Z'),
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    };
    const cursor = encodeWorkspaceMemberCursor({
      createdAt: '2026-08-20T12:00:00.123456Z',
      userId: actorId,
    });
    vi.mocked(store.listWorkspaceMembers).mockResolvedValue({
      items: [member],
      nextCursor: { createdAt: '2026-08-20T12:00:00.654321Z', userId: actorId },
    });
    const authorization = {
      findAccess: vi
        .fn<NonNullable<WorkspaceAuthorizationReader['findAccess']>>()
        .mockResolvedValue(activeAccess('owner')),
    } satisfies WorkspaceAuthorizationReader;
    const result = await new ListWorkspaceMembersUseCase(
      store,
      authorization,
    ).execute({
      actor: actor(),
      routeWorkspaceId: workspaceId,
      limit: 1,
      after: cursor,
    });
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe(
      encodeWorkspaceMemberCursor({
        createdAt: '2026-08-20T12:00:00.654321Z',
        userId: actorId,
      }),
    );
    expect(store.listWorkspaceMembers).toHaveBeenCalledWith(
      workspaceId,
      actorId,
      {
        limit: 1,
        after: { createdAt: '2026-08-20T12:00:00.123456Z', userId: actorId },
      },
    );
  });

  it('returns a null member cursor when persistence has no next page', async () => {
    const store = persistence();
    const authorization = {
      findAccess: vi
        .fn<NonNullable<WorkspaceAuthorizationReader['findAccess']>>()
        .mockResolvedValue(activeAccess('owner')),
    } satisfies WorkspaceAuthorizationReader;

    await expect(
      new ListWorkspaceMembersUseCase(store, authorization).execute({
        actor: actor(),
        routeWorkspaceId: workspaceId,
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('rejects malformed member cursor encoding before persistence', async () => {
    const store = persistence();
    const authorization = {
      findAccess: vi
        .fn<NonNullable<WorkspaceAuthorizationReader['findAccess']>>()
        .mockResolvedValue(activeAccess('owner')),
    } satisfies WorkspaceAuthorizationReader;

    await expect(
      new ListWorkspaceMembersUseCase(store, authorization).execute({
        actor: actor(),
        routeWorkspaceId: workspaceId,
        after: 'not-a-canonical-cursor',
      }),
    ).rejects.toBeInstanceOf(InvalidWorkspaceMemberCursorError);
    expect(store.listWorkspaceMembers).not.toHaveBeenCalled();
  });

  it.each([
    'not-a-time',
    '2026-02-30T12:00:00.123456Z',
    '2026-08-20T25:00:00.123456Z',
    '0000-08-20T12:00:00.123456Z',
  ])(
    'rejects invalid member cursor timestamp %s before touching persistence',
    async (createdAt) => {
      const store = persistence();
      const authorization = {
        findAccess: vi
          .fn<NonNullable<WorkspaceAuthorizationReader['findAccess']>>()
          .mockResolvedValue(activeAccess('owner')),
      } satisfies WorkspaceAuthorizationReader;
      await expect(
        new ListWorkspaceMembersUseCase(store, authorization).execute({
          actor: actor(),
          routeWorkspaceId: workspaceId,
          after: Buffer.from(
            JSON.stringify({
              kind: 'workspace_members',
              createdAt,
              userId: actorId,
            }),
          ).toString('base64url'),
        }),
      ).rejects.toBeInstanceOf(InvalidWorkspaceMemberCursorError);
      expect(store.listWorkspaceMembers).not.toHaveBeenCalled();
    },
  );
}
