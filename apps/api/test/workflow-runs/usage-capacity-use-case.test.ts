import { describe, expect, it, vi } from 'vitest';

import {
  AuthorizationError,
  authorizeWorkspace,
  createActorContext,
  type WorkspaceStatus,
} from '../../src/workspaces/index.js';
import type { WorkflowRunPersistence } from '../../src/workflow-runs/ports.js';
import { GetUsageCapacityUseCase } from '../../src/workflow-runs/usage-capacity-use-case.js';
import { usageCapacitySnapshot } from '../support/usage-capacity.fixture.js';

const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId: '44444444-4444-4444-8444-444444444444',
  requestId: 'usage-capacity-request',
});

function access(workspaceStatus: WorkspaceStatus = 'active') {
  return {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role: 'viewer' as const,
      membershipStatus: 'active' as const,
      workspaceStatus,
    }),
  };
}

function persistence() {
  return {
    usageCapacity: vi
      .fn<WorkflowRunPersistence['usageCapacity']>()
      .mockResolvedValue(usageCapacitySnapshot()),
  };
}

describe('workspace usage capacity use case', () => {
  it('returns exact capacity only after both capability authorizations', async () => {
    const store = persistence();
    const authorization = access();
    const signal = new AbortController().signal;
    const result = await new GetUsageCapacityUseCase(
      store,
      authorization,
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      signal,
    });
    expect(result).toEqual(usageCapacitySnapshot());
    expect(authorization.findAccess).toHaveBeenCalledTimes(2);
    expect(store.usageCapacity).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      signal,
    });
  });

  it.each(['suspended', 'pending_deletion', 'deleted'] as const)(
    'does not read or disclose capacity in a %s workspace',
    async (status) => {
      const store = persistence();
      await expect(
        new GetUsageCapacityUseCase(store, access(status)).execute({
          actor,
          routeWorkspaceId: workspaceId,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      expect(store.usageCapacity).not.toHaveBeenCalled();
    },
  );

  it('does not read for an outsider or inactive membership', async () => {
    const store = persistence();
    const inactive = access();
    inactive.findAccess.mockResolvedValue({
      actorId,
      workspaceId,
      role: 'viewer',
      membershipStatus: 'suspended',
      workspaceStatus: 'active',
    });
    for (const authorization of [
      { findAccess: vi.fn().mockResolvedValue(undefined) },
      inactive,
    ]) {
      await expect(
        new GetUsageCapacityUseCase(store, authorization).execute({
          actor,
          routeWorkspaceId: workspaceId,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    }
    expect(store.usageCapacity).not.toHaveBeenCalled();
  });

  it('does not use a run-read guard proof as artifact-read authorization', async () => {
    const store = persistence();
    const authorization = access();
    const proof = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      capability: 'run:read',
      access: authorization,
    });
    authorization.findAccess.mockResolvedValue(undefined);
    await expect(
      new GetUsageCapacityUseCase(store, authorization).execute({
        actor,
        routeWorkspaceId: workspaceId,
        authorizedWorkspace: proof,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(store.usageCapacity).not.toHaveBeenCalled();
  });

  it('validates the artifact guard proof but still rechecks run access', async () => {
    const store = persistence();
    const authorization = access();
    const proof = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      capability: 'artifact:read',
      access: authorization,
    });
    authorization.findAccess.mockClear();
    await expect(
      new GetUsageCapacityUseCase(store, authorization).execute({
        actor,
        routeWorkspaceId: workspaceId,
        authorizedWorkspace: proof,
      }),
    ).resolves.toEqual(usageCapacitySnapshot());
    expect(authorization.findAccess).toHaveBeenCalledTimes(1);
  });

  it('refuses cancellation and invalid public snapshots before response', async () => {
    const store = persistence();
    const abort = new AbortController();
    abort.abort();
    await expect(
      new GetUsageCapacityUseCase(store, access()).execute({
        actor,
        routeWorkspaceId: workspaceId,
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    expect(store.usageCapacity).not.toHaveBeenCalled();
    store.usageCapacity.mockResolvedValue({
      ...usageCapacitySnapshot(),
      artifacts: { ...usageCapacitySnapshot().artifacts, chargedBytes: '-1' },
    });
    await expect(
      new GetUsageCapacityUseCase(store, access()).execute({
        actor,
        routeWorkspaceId: workspaceId,
      }),
    ).rejects.toThrow();
  });
});
