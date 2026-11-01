import type { Role } from '@pertexo/workflow-model';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowErrorDatabase } from '@pertexo/core/authoring';
import { WorkflowErrorUseCase } from '../../../src/workflow-authoring/settings/error-workflow.js';
import { createActorContext } from '../../../src/authorization/index.js';

const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  requestId: 'error-policy-test',
});
const input = { actor, routeWorkspaceId: workspaceId, workflowId };
function fixture(role: Role = 'owner') {
  const settings = { targetWorkflowId: null, revision: 1 };
  const persistence = {
    readSettings: vi.fn().mockResolvedValue(settings),
    updateSettings: vi.fn().mockResolvedValue({ settings, replayed: false }),
    listTargets: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  } satisfies WorkflowErrorDatabase;
  const authorization = {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role,
      membershipStatus: 'active',
      workspaceStatus: 'active',
    }),
  };
  return {
    persistence,
    controls: new WorkflowErrorUseCase(persistence, authorization),
  };
}
describe('error workflow Settings boundary', () => {
  it('passes the exact actor, independent revision, idempotency key and signal', async () => {
    const f = fixture('builder');
    const signal = new AbortController().signal;
    await f.controls.update({
      ...input,
      signal,
      request: { targetWorkflowId: null, expectedRevision: 1 },
      idempotencyKey: 'one-change',
    });
    expect(f.persistence.updateSettings).toHaveBeenCalledWith({
      workspaceId,
      workflowId,
      actorId,
      signal,
      requestId: 'error-policy-test',
      targetWorkflowId: null,
      expectedRevision: 1,
      idempotencyKey: 'one-change',
    });
  });
  it.each(['viewer', 'operator'] as const)(
    'allows %s reads but denies selecting or discovering edit targets',
    async (role) => {
      const f = fixture(role);
      await expect(f.controls.read(input)).resolves.toEqual({
        targetWorkflowId: null,
        revision: 1,
      });
      await expect(
        f.controls.update({
          ...input,
          request: { targetWorkflowId: null, expectedRevision: 1 },
          idempotencyKey: 'no-authority',
        }),
      ).rejects.toMatchObject({ code: 'resource.not_found' });
      await expect(
        f.controls.targets({ ...input, request: {} }),
      ).rejects.toMatchObject({ code: 'resource.not_found' });
      expect(f.persistence.updateSettings).not.toHaveBeenCalled();
      expect(f.persistence.listTargets).not.toHaveBeenCalled();
    },
  );
  it.each([
    { targetWorkflowId: workflowId, expectedRevision: 0 },
    { targetWorkflowId: 'foreign-id', expectedRevision: 1 },
    {
      targetWorkflowId: null,
      expectedRevision: 1,
      input: { password: 'secret' },
    },
    {
      targetWorkflowId: null,
      expectedRevision: 1,
      targetWorkflowName: 'forged',
    },
  ])(
    'rejects malformed or speculative settings at the HTTP boundary',
    async (request) => {
      const f = fixture();
      await expect(
        f.controls.update({ ...input, request, idempotencyKey: 'invalid' }),
      ).rejects.toMatchObject({ name: 'ZodError' });
      expect(f.persistence.updateSettings).not.toHaveBeenCalled();
    },
  );
});
