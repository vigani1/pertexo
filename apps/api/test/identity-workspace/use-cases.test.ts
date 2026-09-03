import { describe, expect, it, vi } from 'vitest';
import { WorkspaceLifecycleConflictError } from '@pertexo/database/testing';

import {
  CreateWorkspaceUseCase,
  OidcApplicationService,
  WorkspaceLifecycleUseCase,
  workspaceCreateRequestSchema,
} from '../../src/identity-workspace/index.js';
import {
  authorizeWorkspace,
  createActorContext,
} from '../../src/workspaces/index.js';
import type { WorkspaceAuthorizationReader } from '../../src/identity-workspace/ports.js';
import type { WorkspaceAccess } from '../../src/workspaces/index.js';
import { OpaqueSessionService } from '../../src/identity/index.js';

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
    status: 'pending' as const,
    submittedAt: new Date('2026-08-20T12:00:00.000Z'),
    updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    completedAt: null,
    errorCode: null,
  };
}

function persistence() {
  return {
    create: vi.fn(),
    findByDigest: vi.fn(),
    revokeByDigest: vi.fn(),
    resolveOrCreateIdentity: vi.fn(),
    createWorkspaceWithOwner: vi.fn().mockResolvedValue(workspace()),
    requestWorkspaceLifecycleOperation: vi
      .fn()
      .mockImplementation(
        (input: { commandType: 'deletion_requested' | 'deletion_restored' }) =>
          Promise.resolve(operation(input.commandType)),
      ),
    readWorkspaceLifecycleOperation: vi.fn().mockResolvedValue(operation()),
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

    await new WorkspaceLifecycleUseCase(store, authorization).readOperation({
      actor: requestActor,
      authorizedWorkspace,
      routeWorkspaceId: workspaceId,
      operationId: operation().id,
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

  it('maps OIDC identity into an opaque session and hands cookies to the boundary', async () => {
    const oidc = {
      startLogin: () =>
        Promise.resolve({
          authorizationUrl: 'https://issuer.example.test/authorize',
          expiresAt: new Date('2026-08-20T20:00:00.000Z'),
          browserBindingMaxAgeSeconds: 300,
          browserBinding: 'browser-binding-secret',
        }),
      completeLogin: vi.fn().mockResolvedValue({
        externalIdentity: {
          issuer: 'https://issuer.example',
          subject: 'sub-1',
        },
        internalIdentity: { userId: actorId },
        verifiedProfile: {
          email: 'person@example.test',
          displayName: 'Person',
        },
      }),
    };
    const sessions = {
      issue: vi.fn().mockResolvedValue({
        sessionId,
        expiresAt: new Date('2026-08-20T20:00:00.000Z'),
        cookieOptions: {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/',
          maxAgeSeconds: 28_800,
        },
      }),
    };
    const app = new OidcApplicationService(oidc, sessions);
    const cookieBoundary = { writeSessionCookie: vi.fn() };

    const result = await app.complete(
      { code: 'code', state: 'state-value-123456' },
      'browser-binding-secret',
      cookieBoundary,
    );

    expect(result.userId).toBe(actorId);
    expect(oidc.completeLogin).toHaveBeenCalledWith(
      { code: 'code', state: 'state-value-123456' },
      'browser-binding-secret',
    );
    expect(sessions.issue).toHaveBeenCalledWith(
      { userId: actorId },
      cookieBoundary,
    );
  });

  it('creates a workspace with owner and request/trace audit identity atomically through one persistence port', async () => {
    const store = persistence();
    const app = new CreateWorkspaceUseCase(store);

    const result = await app.execute({
      actorId,
      idempotencyKey,
      name: ' Operations ',
      slug: 'operations',
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
    ).resolves.toMatchObject({ status: 'pending' });
    await expect(
      app.restore({
        actor: actor(),
        idempotencyKey,
        routeWorkspaceId: workspaceId,
      }),
    ).resolves.toMatchObject({ status: 'pending' });
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
    ).resolves.toMatchObject({
      commandType: 'deletion_requested',
      status: 'pending',
      result: null,
    });
    await expect(
      app.restore({
        actor: actor(),
        idempotencyKey,
        routeWorkspaceId: workspaceId,
      }),
    ).resolves.toMatchObject({
      commandType: 'deletion_restored',
      status: 'pending',
    });

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

describe('session authentication boundary', () => {
  it('does not allow a revoked session to become an authenticated request', async () => {
    const sessions = new OpaqueSessionService({
      create: vi.fn(),
      findByDigest: vi.fn().mockResolvedValue(undefined),
      revokeByDigest: vi.fn(),
    });

    await expect(sessions.authenticate('x'.repeat(32))).rejects.toMatchObject({
      code: 'identity.session_invalid',
    });
  });
});
