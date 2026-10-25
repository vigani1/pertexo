import { expect, it, vi } from 'vitest';
import { WorkspaceLifecycleConflictError } from '@pertexo/database/testing';
import {
  CreateWorkspaceUseCase,
  WorkspaceLifecycleUseCase,
  workspaceCreateRequestSchema,
} from '../../../src/workspaces/index.js';

import { authorizeWorkspace } from '../../../src/authorization/index.js';
import type { WorkspaceAuthorizationReader } from '../../../src/workspaces/ports.js';

import {
  actorId,
  workspaceId,
  requestId,
  idempotencyKey,
  workspace,
  persistence,
  activeAccess,
  actor,
} from './fixture.js';

export function registerReusesGuardAuthorizationLifecycleOperations(): void {
  it('reuses guard authorization for lifecycle operations', async () => {
    const store = persistence();
    const authorization = {
      findAccess: vi
        .fn<NonNullable<WorkspaceAuthorizationReader['findAccess']>>()
        .mockResolvedValue(activeAccess()),
    } satisfies WorkspaceAuthorizationReader;
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

  it('rejects unsafe or oversized audit metadata before persistence', async () => {
    for (const metadata of [
      { tokenDigest: 'must-not-persist' },
      { value: 'x'.repeat(8192) },
    ]) {
      const store = persistence();
      await expect(
        new CreateWorkspaceUseCase(store).execute({
          actorId,
          idempotencyKey,
          request: { name: 'Operations', slug: 'operations' },
          metadata,
        }),
      ).rejects.toThrow();
      expect(store.createWorkspaceWithOwner).not.toHaveBeenCalled();
    }
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
    const authorization = {
      findAccess: vi
        .fn<NonNullable<WorkspaceAuthorizationReader['findAccess']>>()
        .mockResolvedValue(activeAccess()),
    } satisfies WorkspaceAuthorizationReader;
    const app = new WorkspaceLifecycleUseCase(store, authorization);

    await expect(
      app.requestDeletion({
        actor: actor(),
        idempotencyKey,
        routeWorkspaceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        reason: 'retiring the temporary workspace',
      }),
    ).rejects.toMatchObject({ code: 'auth.forbidden' });
    expect(vi.mocked(authorization.findAccess)).not.toHaveBeenCalled();
    expect(store.requestWorkspaceLifecycleOperation).not.toHaveBeenCalled();
  });

  it('denies a non-owner capability and does not call lifecycle persistence', async () => {
    const store = persistence();
    const authorization = {
      findAccess: vi
        .fn<NonNullable<WorkspaceAuthorizationReader['findAccess']>>()
        .mockResolvedValue(activeAccess('builder')),
    } satisfies WorkspaceAuthorizationReader;
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
    const authorization = {
      findAccess: vi
        .fn<NonNullable<WorkspaceAuthorizationReader['findAccess']>>()
        .mockResolvedValue(undefined),
    } satisfies WorkspaceAuthorizationReader;
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
}
