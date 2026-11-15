import type { Role } from '@pertexo/policy';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createActorContext } from '../../src/authorization/index.js';
import { WorkflowTestSuitesService } from '../../src/node-testing/suites/workflow-test-suites.service.js';
const workspaceId = randomUUID(),
  actorId = randomUUID(),
  workflowId = randomUUID(),
  suiteId = randomUUID();
const actor = createActorContext({
  workspaceId,
  actorId,
  sessionId: randomUUID(),
  requestId: 'suite-test',
});
const input = { actor, routeWorkspaceId: workspaceId, workflowId };
function fixture(role: Role = 'owner') {
  const store = {
    prepare: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    report: vi.fn(),
    start: vi.fn().mockResolvedValue({ suiteId }),
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
  return { store, service: new WorkflowTestSuitesService(store, access) };
}
const request = {
  expectedRevision: 1,
  expectedSamples: [],
  expectedEffectfulSteps: ['http'],
  expectedCases: [{ id: randomUUID(), revision: 2 }],
  expectedVariableSetRevision: 3,
  signature: 'a'.repeat(64),
  acknowledgeSideEffects: true,
};
describe('draft suite boundary', () => {
  it('passes the complete frozen manifest and effects consent to atomic storage', async () => {
    const f = fixture(),
      idempotencyKey = randomUUID();
    expect(
      await f.service.start({ ...input, request, idempotencyKey }),
    ).toEqual({ suiteId });
    expect(f.store.start).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      workflowId,
      actorId,
      request,
      idempotencyKey,
    });
  });
  it('requires editor and run permissions for all reports and commands', async () => {
    const f = fixture('viewer');
    await expect(f.service.prepare(input)).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    await expect(f.service.list(input)).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    await expect(f.service.get({ ...input, suiteId })).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    await expect(
      f.service.report({ ...input, suiteId, ordinal: 0 }),
    ).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    await expect(f.service.cancel({ ...input, suiteId })).rejects.toMatchObject(
      { name: 'AuthorizationError', code: 'resource.not_found' },
    );
    expect(f.store.prepare).not.toHaveBeenCalled();
    expect(f.store.report).not.toHaveBeenCalled();
    expect(f.store.cancel).not.toHaveBeenCalled();
  });
});
