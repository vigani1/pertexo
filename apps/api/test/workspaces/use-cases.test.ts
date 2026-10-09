import { describe, expect, it, vi } from 'vitest';
import { WorkspaceLifecycleConflictError } from '@pertexo/database/testing';

import {
  CreateWorkspaceUseCase,
  ChangeWorkspaceMemberRoleUseCase,
  GetCurrentUserUseCase,
  ListAccessibleWorkspacesUseCase,
  ListWorkspaceMembersUseCase,
  WorkspaceLifecycleUseCase,
  workspaceCreateRequestSchema,
} from '../../src/workspaces/index.js';
import { encodeWorkspaceMemberCursor } from '../../src/workspaces/index.js';
import {
  authorizeWorkspace,
  createActorContext,
} from '../../src/authorization/index.js';
import type { WorkspaceAuthorizationReader } from '../../src/workspaces/ports.js';
import type { WorkspaceAccess } from '../../src/authorization/index.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const requestId = 'request-42';
const idempotencyKey = 'workspace-command-42';

function workspace() {
  return {
    id: workspaceId,
    name: 'Operations',
    slug: 'operations',
    status: 'active' as const,
    createdAt: new Date('2026-08-20T12:00:00.000Z'),
    updatedAt: new Date('2026-08-20T12:00:00.000Z'),
  };
}

function operation(
  commandType:
    'deletion_requested' | 'deletion_restored' = 'deletion_requested',
) {
  return {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    workspaceId,
    commandType,
    submittedAt: new Date('2026-08-20T12:00:00.000Z'),
  };
}

function user() {
  return {
    id: actorId,
    email: 'person@example.test',
    displayName: 'Person',
    status: 'active' as const,
    profileRevision: 3,
    createdAt: new Date('2026-08-20T12:00:00.000Z'),
    updatedAt: new Date('2026-08-20T12:00:00.000Z'),
  };
}

function persistence() {
  return {
    findUserById: vi.fn(),
    listAccessibleWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
    listWorkspaceMembers: vi.fn().mockResolvedValue({ items: [] }),
    changeWorkspaceMemberRole: vi.fn().mockResolvedValue({
      userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      role: 'operator',
      roleRevision: 2,
      changed: true,
      replayed: false,
    }),
    createWorkspaceWithOwner: vi.fn().mockResolvedValue(workspace()),
    requestWorkspaceLifecycleOperation: vi
      .fn()
      .mockImplementation(
        (input: { commandType: 'deletion_requested' | 'deletion_restored' }) =>
          Promise.resolve(operation(input.commandType)),
      ),
  };
}

function activeAccess(
  role: WorkspaceAccess['role'] = 'owner',
  workspaceStatus: WorkspaceAccess['workspaceStatus'] = 'active',
): WorkspaceAccess {
  return {
    actorId,
    workspaceId,
    role,
    membershipStatus: 'active',
    workspaceStatus,
  };
}

function actor() {
  return createActorContext({
    actorId,
    workspaceId,
    sessionId,
    requestId,
    traceId: 'trace-42',
  });
}

describe('identity/workspace application use cases', () => {
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
    const authorization: WorkspaceAuthorizationReader = {
      findAccess: vi.fn().mockResolvedValue(activeAccess('owner')),
    };
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
    const authorization: WorkspaceAuthorizationReader = {
      findAccess: vi.fn().mockResolvedValue(activeAccess('owner')),
    };

    await expect(
      new ListWorkspaceMembersUseCase(store, authorization).execute({
        actor: actor(),
        routeWorkspaceId: workspaceId,
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('rejects malformed member cursor encoding before persistence', async () => {
    const store = persistence();
    const authorization: WorkspaceAuthorizationReader = {
      findAccess: vi.fn().mockResolvedValue(activeAccess('owner')),
    };

    await expect(
      new ListWorkspaceMembersUseCase(store, authorization).execute({
        actor: actor(),
        routeWorkspaceId: workspaceId,
        after: 'not-a-canonical-cursor',
      }),
    ).rejects.toMatchObject({ code: 'request.invalid' });
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
      const authorization: WorkspaceAuthorizationReader = {
        findAccess: vi.fn().mockResolvedValue(activeAccess('owner')),
      };
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
      ).rejects.toMatchObject({ code: 'request.invalid' });
      expect(store.listWorkspaceMembers).not.toHaveBeenCalled();
    },
  );
  it('reuses guard authorization for lifecycle operations', async () => {
    const store = persistence();
    const authorization: WorkspaceAuthorizationReader = {
      findAccess: vi.fn().mockResolvedValue(activeAccess()),
    };
    const requestActor = actor();
    const authorizedWorkspace = await authorizeWorkspace({
      actor: requestActor,
      routeWorkspaceId: workspaceId,
      capability: 'workspace:manage',
      access: authorization,
      disclosure: 'forbidden',
      allowedWorkspaceStatuses: ['active', 'suspended', 'pending_deletion'],
    });

    await new WorkspaceLifecycleUseCase(store, authorization).requestDeletion({
      actor: requestActor,
      authorizedWorkspace,
      idempotencyKey,
      routeWorkspaceId: workspaceId,
      reason: 'retiring the temporary workspace',
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(authorization.findAccess)).toHaveBeenCalledTimes(1);
  });

  it('matches persistence workspace name and slug limits exactly', () => {
    expect(
      workspaceCreateRequestSchema.parse({
        name: 'n'.repeat(128),
        slug: 's'.repeat(64),
      }),
    ).toEqual({
      name: 'n'.repeat(128),
      slug: 's'.repeat(64),
    });
    expect(() =>
      workspaceCreateRequestSchema.parse({
        name: 'n'.repeat(129),
        slug: 's'.repeat(64),
      }),
    ).toThrow();
    expect(() =>
      workspaceCreateRequestSchema.parse({
        name: 'n'.repeat(128),
        slug: 's'.repeat(65),
      }),
    ).toThrow();
  });

  it('creates a workspace with owner and request/trace audit identity atomically through one persistence port', async () => {
    const store = persistence();
    const app = new CreateWorkspaceUseCase(store);

    const result = await app.execute({
      actorId,
      idempotencyKey,
      request: { name: ' Operations ', slug: 'operations' },
      requestId,
      traceId: 'trace-42',
    });

    expect(result).toEqual({
      ...workspace(),
      createdAt: '2026-08-20T12:00:00.000Z',
      updatedAt: '2026-08-20T12:00:00.000Z',
    });
    expect(vi.mocked(store.createWorkspaceWithOwner)).toHaveBeenCalledWith({
      ownerUserId: actorId,
      idempotencyKey,
      name: 'Operations',
      slug: 'operations',
      requestId,
      traceId: 'trace-42',
      metadata: {},
    });
  });

  it('preserves omitted optional audit identity for workspace creation', async () => {
    const store = persistence();
    await new CreateWorkspaceUseCase(store).execute({
      actorId,
      idempotencyKey,
      request: { name: 'Operations', slug: 'operations' },
    });
    const call = vi.mocked(store.createWorkspaceWithOwner).mock.calls[0];
    expect(Object.hasOwn(call?.[0] as object, 'requestId')).toBe(false);
    expect(Object.hasOwn(call?.[0] as object, 'traceId')).toBe(false);
  });

  it('authorizes deletion before accepting a lifecycle operation', async () => {
    const store = persistence();
    const authorization: WorkspaceAuthorizationReader = {
      findAccess: vi.fn().mockResolvedValue(activeAccess()),
    };
    const app = new WorkspaceLifecycleUseCase(store, authorization);

    await expect(
      app.requestDeletion({
        actor: actor(),
        idempotencyKey,
        routeWorkspaceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        reason: 'retiring the temporary workspace',
      }),
    ).rejects.toMatchObject({ code: 'auth.forbidden' });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(authorization.findAccess)).not.toHaveBeenCalled();
    expect(store.requestWorkspaceLifecycleOperation).not.toHaveBeenCalled();
  });

  it('denies a non-owner capability and does not call lifecycle persistence', async () => {
    const store = persistence();
    const authorization: WorkspaceAuthorizationReader = {
      findAccess: vi.fn().mockResolvedValue(activeAccess('builder')),
    };
    const app = new WorkspaceLifecycleUseCase(store, authorization);

    await expect(
      app.requestDeletion({
        actor: actor(),
        idempotencyKey,
        routeWorkspaceId: workspaceId,
        reason: 'retiring the temporary workspace',
      }),
    ).rejects.toMatchObject({ code: 'auth.forbidden' });
    expect(store.requestWorkspaceLifecycleOperation).not.toHaveBeenCalled();
  });

  it('keeps a missing workspace indistinguishable from unauthorized access', async () => {
    const store = persistence();
    const authorization: WorkspaceAuthorizationReader = {
      findAccess: vi.fn().mockResolvedValue(undefined),
    };
    const app = new WorkspaceLifecycleUseCase(store, authorization);

    await expect(
      app.requestDeletion({
        actor: actor(),
        idempotencyKey,
        routeWorkspaceId: workspaceId,
        reason: 'retiring the temporary workspace',
      }),
    ).rejects.toMatchObject({ code: 'auth.forbidden' });
    expect(store.requestWorkspaceLifecycleOperation).not.toHaveBeenCalled();
  });

  it('authorizes visible owner lifecycle states and leaves exact transition conflicts to persistence', async () => {
    const store = persistence();
    const authorization: WorkspaceAuthorizationReader = {
      findAccess: vi
        .fn()
        .mockResolvedValueOnce(activeAccess('owner', 'suspended'))
        .mockResolvedValueOnce(activeAccess('owner', 'pending_deletion'))
        .mockResolvedValueOnce(activeAccess()),
    };
    const app = new WorkspaceLifecycleUseCase(store, authorization);

    await expect(
      app.requestDeletion({
        actor: actor(),
        idempotencyKey,
        routeWorkspaceId: workspaceId,
        reason: 'retiring the suspended workspace',
      }),
    ).resolves.toMatchObject({ change: 'deletion_requested' });
    await expect(
      app.restore({
        actor: actor(),
        idempotencyKey,
        routeWorkspaceId: workspaceId,
      }),
    ).resolves.toMatchObject({ change: 'deletion_restored' });
    const conflict = new WorkspaceLifecycleConflictError(
      'invalid_state',
      'Workspace is not pending deletion',
    );
    store.requestWorkspaceLifecycleOperation.mockRejectedValueOnce(conflict);
    await expect(
      app.restore({
        actor: actor(),
        idempotencyKey,
        routeWorkspaceId: workspaceId,
      }),
    ).rejects.toBe(conflict);
    expect(store.requestWorkspaceLifecycleOperation).toHaveBeenCalledTimes(3);
  });

  it('answers a deletion request with the change it applied', async () => {
    const app = new WorkspaceLifecycleUseCase(persistence(), {
      findAccess: vi.fn().mockResolvedValue(activeAccess()),
    });

    await expect(
      app.requestDeletion({
        actor: actor(),
        idempotencyKey,
        routeWorkspaceId: workspaceId,
        reason: 'retiring the temporary workspace',
      }),
    ).resolves.toEqual({
      workspaceId,
      change: 'deletion_requested',
      occurredAt: '2026-08-20T12:00:00.000Z',
    });
  });

  it('denies lifecycle access to a deleted workspace before persistence', async () => {
    const store = persistence();
    const authorization: WorkspaceAuthorizationReader = {
      findAccess: vi.fn().mockResolvedValue(activeAccess('owner', 'deleted')),
    };
    const app = new WorkspaceLifecycleUseCase(store, authorization);

    await expect(
      app.restore({
        actor: actor(),
        idempotencyKey,
        routeWorkspaceId: workspaceId,
      }),
    ).rejects.toMatchObject({ code: 'auth.forbidden' });
    expect(store.requestWorkspaceLifecycleOperation).not.toHaveBeenCalled();
  });

  it('returns lifecycle transitions and preserves persistence failures for rollback/error mapping', async () => {
    const store = persistence();
    const authorization: WorkspaceAuthorizationReader = {
      findAccess: vi
        .fn()
        .mockResolvedValueOnce(activeAccess())
        .mockResolvedValueOnce(activeAccess('owner', 'pending_deletion'))
        .mockResolvedValue(activeAccess()),
    };
    const app = new WorkspaceLifecycleUseCase(store, authorization);

    await expect(
      app.requestDeletion({
        actor: actor(),
        idempotencyKey,
        routeWorkspaceId: workspaceId,
        reason: 'retiring the temporary workspace',
      }),
    ).resolves.toMatchObject({ change: 'deletion_requested', workspaceId });
    await expect(
      app.restore({
        actor: actor(),
        idempotencyKey,
        routeWorkspaceId: workspaceId,
      }),
    ).resolves.toMatchObject({ change: 'deletion_restored' });

    const failure = new Error('transaction rolled back');
    store.requestWorkspaceLifecycleOperation.mockRejectedValueOnce(failure);
    await expect(
      app.requestDeletion({
        actor: actor(),
        idempotencyKey,
        routeWorkspaceId: workspaceId,
        reason: 'retiring the temporary workspace',
      }),
    ).rejects.toBe(failure);
  });
});
