import type { Role } from '@pertexo/workflow-model';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createActorContext,
  authorizeWorkspace,
} from '../../src/authorization/index.js';
import { WorkflowTestsUseCase } from '../../src/node-testing/workflows/use-case.js';
const workspaceId = randomUUID(),
  actorId = randomUUID(),
  workflowId = randomUUID();
const actor = createActorContext({
  workspaceId,
  actorId,
  sessionId: randomUUID(),
  requestId: 'draft-test',
});
const input = { actor, routeWorkspaceId: workspaceId, workflowId };
function fixture(role: Role = 'owner') {
  const store = {
    prepare: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    start: vi.fn().mockResolvedValue({ runId: randomUUID() }),
    cancel: vi.fn(),
  };
  const access = {
    findAccess: vi.fn().mockResolvedValue({
      workspaceId,
      actorId,
      role,
      membershipStatus: 'active',
      workspaceStatus: 'active',
    }),
  };
  return { store, access, useCase: new WorkflowTestsUseCase(store, access) };
}
describe('draft workflow test boundary', () => {
  it('uses the guard proof only for its original capability and independently checks run permissions', async () => {
    const f = fixture();
    const authorizedWorkspace = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      access: f.access,
      capability: 'workflow:update',
    });
    const preparation = { draftRevision: 1, samples: [], effectfulSteps: [] };
    f.store.prepare.mockResolvedValue(preparation);
    await expect(
      f.useCase.prepare({ ...input, authorizedWorkspace }),
    ).resolves.toEqual(preparation);
  });
  // api-13: the run capabilities come from one membership read, not one each.
  it('reads membership at most once beyond the guard proof', async () => {
    const f = fixture();
    const authorizedWorkspace = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      access: f.access,
      capability: 'workflow:update',
    });
    f.access.findAccess.mockClear();
    f.store.prepare.mockResolvedValue({
      draftRevision: 1,
      samples: [],
      effectfulSteps: [],
    });
    await f.useCase.prepare({ ...input, authorizedWorkspace });
    expect(f.access.findAccess.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it('passes an explicit effects acknowledgement and frozen pin/revision expectations to transactional admission', async () => {
    const f = fixture();
    const request = {
      expectedRevision: 3,
      expectedSamples: [],
      expectedEffectfulSteps: ['http'],
      input: { customer: 7 },
      acknowledgeSideEffects: true,
    };
    const idempotencyKey = randomUUID();
    await f.useCase.start({ ...input, request, idempotencyKey });
    expect(f.store.start).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      workflowId,
      actorId,
      idempotencyKey,
      request,
    });
  });
  it('refuses malformed commands before storage', async () => {
    const f = fixture();
    const request = {
      expectedRevision: 3,
      expectedSamples: [],
      expectedEffectfulSteps: [],
      input: {},
      acknowledgeSideEffects: false,
    };
    for (const invalid of [
      { ...request, acknowledgeSideEffects: 'yes' },
      { ...request, expectedEffectfulSteps: undefined },
      { ...request, overrides: {} },
    ])
      await expect(
        f.useCase.start({
          ...input,
          request: invalid,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ name: 'ZodError' });
    expect(f.store.start).not.toHaveBeenCalled();
  });
  it('requires edit authority even when a person can read normal run data', async () => {
    const f = fixture('viewer');
    await expect(f.useCase.prepare(input)).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    await expect(f.useCase.list(input)).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    expect(f.store.prepare).not.toHaveBeenCalled();
    expect(f.store.list).not.toHaveBeenCalled();
  });
});
