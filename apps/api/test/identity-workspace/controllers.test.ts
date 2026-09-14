import { describe, expect, it, vi } from 'vitest';

import {
  CreateWorkspaceUseCase,
  GetCurrentUserUseCase,
  ListWorkspaceMembersUseCase,
  UserController,
  WorkspaceMembersController,
  WorkspaceController,
  type CookieResponse,
  type IdentityWorkspaceRequest,
  type WorkspaceLifecycleUseCase,
} from '../../src/identity-workspace/index.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const guardActorId = '99999999-9999-4999-8999-999999999999';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function workspaceRequest() {
  return {
    requestId: 'request-identity',
    traceId: 'trace-identity',
    headers: { 'idempotency-key': 'workspace-lifecycle' },
    identitySession: {
      userId: actorId,
      sessionId,
      expiresAt: new Date('2026-08-23T00:00:00.000Z'),
      clientMetadata: {},
    },
  } as const;
}

function lifecycleController(lifecycle: object): WorkspaceController {
  return new WorkspaceController(
    { execute: vi.fn() } as unknown as CreateWorkspaceUseCase,
    lifecycle as unknown as WorkspaceLifecycleUseCase,
  );
}

describe('identity workspace-route controllers', () => {
  it('projects absent and guard-established context through lifecycle commands', async () => {
    const lifecycle = {
      requestDeletion: vi.fn().mockResolvedValue({
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        workspaceId,
        commandType: 'deletion_requested',
        status: 'pending',
        submittedAt: '2026-08-20T12:00:00.000Z',
        updatedAt: '2026-08-20T12:00:00.000Z',
        completedAt: null,
        errorCode: null,
        result: null,
      }),
      restore: vi.fn(),
      readOperation: vi.fn(),
    };
    const controller = lifecycleController(lifecycle);

    await controller.requestDeletion(
      workspaceRequest(),
      { workspaceId },
      { reason: 'operator request' },
    );
    expect(lifecycle.requestDeletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest asymmetric matcher verifies the nested actor projection.
        actor: expect.objectContaining({
          actorId,
          requestId: 'request-identity',
          traceId: 'trace-identity',
        }),
        requestId: 'request-identity',
        traceId: 'trace-identity',
      }),
    );
    expect(lifecycle.requestDeletion.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      'authorizedWorkspace',
    );

    const authorizedWorkspace = {
      actor: Object.freeze({
        actorId: guardActorId,
        kind: 'user' as const,
        workspaceId,
        sessionId,
        requestId: 'guard-request',
        traceId: 'guard-trace',
      }),
      workspaceId,
      role: 'owner' as const,
      capability: 'workspace:manage' as const,
    };
    await controller.requestDeletion(
      { ...workspaceRequest(), authorizedWorkspace },
      { workspaceId },
      { reason: 'operator request' },
    );
    expect(lifecycle.requestDeletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actor: authorizedWorkspace.actor,
        authorizedWorkspace,
        requestId: 'guard-request',
        traceId: 'guard-trace',
      }),
    );
  });

  it('rejects an invalid lifecycle actor before invoking the use case', async () => {
    const requestDeletion = vi.fn();
    const controller = lifecycleController({
      requestDeletion,
      restore: vi.fn(),
      readOperation: vi.fn(),
    });

    await expect(
      controller.requestDeletion(
        {
          ...workspaceRequest(),
          identitySession: {
            ...workspaceRequest().identitySession,
            userId: 'not-a-uuid',
          },
        },
        { workspaceId },
        { reason: 'operator request' },
      ),
    ).rejects.toMatchObject({
      name: 'InvalidAuthenticatedWorkspaceContextError',
      message: 'actorId must be a canonical UUID',
    });
    expect(requestDeletion).not.toHaveBeenCalled();
  });

  it('returns a complete current profile with private cache policy', async () => {
    const response: CookieResponse = { header: vi.fn() };
    const profile = {
      id: actorId,
      email: 'person@example.test',
      displayName: 'Person',
      status: 'active' as const,
      createdAt: new Date('2026-08-20T12:00:00.000Z'),
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    };
    const controller = new UserController(
      new GetCurrentUserUseCase({
        findUserById: vi.fn().mockResolvedValue(profile),
      }),
    );
    const request = workspaceRequest() satisfies IdentityWorkspaceRequest;

    await expect(controller.me(request, response)).resolves.toEqual({
      ...profile,
      createdAt: '2026-08-20T12:00:00.000Z',
      updatedAt: '2026-08-20T12:00:00.000Z',
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(response.header)).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
  });

  it('parses bounded member pagination and applies private cache policy', async () => {
    const response: CookieResponse = { header: vi.fn() };
    const listWorkspaceMembers = vi.fn().mockResolvedValue({ items: [] });
    const controller = new WorkspaceMembersController(
      new ListWorkspaceMembersUseCase(
        { listWorkspaceMembers },
        {
          findAccess: vi.fn().mockResolvedValue({
            actorId,
            workspaceId,
            role: 'owner',
            membershipStatus: 'active',
            workspaceStatus: 'active',
          }),
        },
      ),
    );

    await controller.list(
      workspaceRequest(),
      { workspaceId },
      { limit: '2' },
      response,
    );
    expect(listWorkspaceMembers).toHaveBeenCalledWith(workspaceId, actorId, {
      limit: 2,
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(response.header)).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    await expect(
      controller.list(
        workspaceRequest(),
        { workspaceId },
        { limit: '101' },
        response,
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('validates workspace creation body with a valid idempotency key', async () => {
    const createWorkspaceWithOwner = vi.fn();
    const controller = new WorkspaceController(
      new CreateWorkspaceUseCase({ createWorkspaceWithOwner }),
      {
        requestDeletion: vi.fn(),
        restore: vi.fn(),
        readOperation: vi.fn(),
      } as unknown as WorkspaceLifecycleUseCase,
    );

    await expect(
      controller.create(workspaceRequest(), {
        name: '',
        slug: 'not valid',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(createWorkspaceWithOwner).not.toHaveBeenCalled();
  });

  it.each([
    ['missing idempotency key', { ...workspaceRequest(), headers: {} }],
    [
      'repeated idempotency key',
      {
        ...workspaceRequest(),
        headers: { 'idempotency-key': ['one', 'two'] },
      },
    ],
  ])('rejects a workspace create with %s', async (_case, request) => {
    const execute = vi.fn();
    const controller = new WorkspaceController(
      { execute } as unknown as CreateWorkspaceUseCase,
      {} as WorkspaceLifecycleUseCase,
    );

    await expect(
      controller.create(request as IdentityWorkspaceRequest, {
        name: 'Operations',
        slug: 'operations',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an invalid workspace route before invoking lifecycle behavior', async () => {
    const requestDeletion = vi.fn();
    const controller = lifecycleController({ requestDeletion });

    await expect(
      controller.requestDeletion(
        workspaceRequest(),
        { workspaceId: 'not-a-uuid' },
        { reason: 'retire it' },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(requestDeletion).not.toHaveBeenCalled();
  });
});
