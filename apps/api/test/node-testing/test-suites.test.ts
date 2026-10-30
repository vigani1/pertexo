import type { Role } from '@pertexo/workflow-model';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createActorContext } from '../../src/authorization/index.js';
import { WorkflowTestSuitesUseCase } from '../../src/node-testing/suites/use-case.js';
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
  return { store, useCase: new WorkflowTestSuitesUseCase(store, access) };
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
      await f.useCase.start({ ...input, request, idempotencyKey }),
    ).toEqual({ suiteId });
    expect(f.store.start).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      workflowId,
      actorId,
      request,
      idempotencyKey,
    });
  });
  it('rejects invalid or overlarge manifests before storage', async () => {
    const f = fixture();
    for (const body of [
      { ...request, acknowledgeSideEffects: 'yes' },
      { ...request, signature: 'old' },
      { ...request, expectedCases: [] },
      {
        ...request,
        expectedCases: Array.from({ length: 51 }, () => ({
          id: randomUUID(),
          revision: 1,
        })),
      },
      { ...request, input: {} },
    ])
      await expect(
        f.useCase.start({
          ...input,
          request: body,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ name: 'ZodError' });
    expect(f.store.start).not.toHaveBeenCalled();
  });
  it('requires editor and run permissions for all reports and commands', async () => {
    const f = fixture('viewer');
    await expect(f.useCase.prepare(input)).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    await expect(f.useCase.list(input)).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    await expect(f.useCase.get({ ...input, suiteId })).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    await expect(
      f.useCase.report({ ...input, suiteId, ordinal: 0 }),
    ).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    await expect(f.useCase.cancel({ ...input, suiteId })).rejects.toMatchObject(
      { name: 'AuthorizationError', code: 'resource.not_found' },
    );
    expect(f.store.prepare).not.toHaveBeenCalled();
    expect(f.store.report).not.toHaveBeenCalled();
    expect(f.store.cancel).not.toHaveBeenCalled();
  });
  it('rejects a malformed stored report rather than returning an unbounded private payload', async () => {
    const f = fixture();
    f.store.report.mockResolvedValue({
      report: { unbounded: 'x'.repeat(100000) },
    });
    await expect(
      f.useCase.report({ ...input, suiteId, ordinal: 0 }),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });
});
