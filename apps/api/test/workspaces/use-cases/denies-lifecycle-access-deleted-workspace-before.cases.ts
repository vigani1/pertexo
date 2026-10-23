import { expect, it, vi } from 'vitest';

import { WorkspaceLifecycleUseCase } from '../../../src/workspaces/index.js';

import type { WorkspaceAuthorizationReader } from '../../../src/workspaces/ports.js';

import {
  workspaceId,
  idempotencyKey,
  persistence,
  activeAccess,
  actor,
} from './fixture.js';

export function registerDeniesLifecycleAccessDeletedWorkspaceBefore(): void {
  it('denies lifecycle access to a deleted workspace before persistence', async () => {
    const store = persistence();
    const authorization = {
      findAccess: vi
        .fn<NonNullable<WorkspaceAuthorizationReader['findAccess']>>()
        .mockResolvedValue(activeAccess('owner', 'deleted')),
    } satisfies WorkspaceAuthorizationReader;
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
}
