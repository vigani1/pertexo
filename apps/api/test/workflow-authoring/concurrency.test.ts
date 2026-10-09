import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { GUARDS_METADATA, HEADERS_METADATA } from '@nestjs/common/constants.js';
import type { WorkflowConcurrencyDatabase } from '@pertexo/database/authoring';
import {
  WorkflowConcurrencyRevisionConflictError,
  WorkflowConcurrencyLimitExceededError,
  WorkflowConcurrencyLimitUnavailableError,
} from '@pertexo/database/authoring';
import { WorkflowConcurrencyUseCase } from '../../src/workflow-authoring/concurrency-use-case.js';
import { WorkflowConcurrencyController } from '../../src/workflow-authoring/concurrency-controller.js';
import {
  WorkflowReadGuard,
  WorkflowUpdateGuard,
} from '../../src/workflow-authoring/guards.js';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
} from '../../src/identity-workspace/index.js';
import { mapWorkflowAuthoringError } from '../../src/workflow-authoring/errors.js';
import { createActorContext } from '../../src/workspaces/index.js';

const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId,
  requestId: 'concurrency-test',
});
const settings = {
  asOf: '2026-10-01T00:00:00.000001Z',
  limit: null,
  revision: 1,
  workspaceActiveRunLimit: null,
  workspacePolicyState: 'unavailable' as const,
  overflow: 'queue' as const,
};
function fixture(
  role: 'owner' | 'admin' | 'builder' | 'operator' | 'viewer' = 'owner',
) {
  const persistence = {
    readSettings: vi.fn().mockResolvedValue(settings),
    updateSettings: vi.fn().mockResolvedValue({ settings, replayed: true }),
  } satisfies WorkflowConcurrencyDatabase;
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
    authorization,
    controls: new WorkflowConcurrencyUseCase(persistence, authorization),
  };
}
const readInput = { actor, routeWorkspaceId: workspaceId, workflowId };
const commandInput = {
  ...readInput,
  idempotencyKey: 'setting-once',
  request: { limit: null, expectedRevision: 1 },
};
describe('workflow concurrency application boundary', () => {
  it('passes exact replay, removal without entitlement, actor attribution and operation signal', async () => {
    const { persistence, controls } = fixture('builder');
    const signal = new AbortController().signal;
    expect(await controls.update({ ...commandInput, signal })).toEqual({
      settings,
      replayed: true,
    });
    expect(persistence.updateSettings).toHaveBeenCalledWith({
      workspaceId,
      workflowId,
      actorId,
      signal,
      idempotencyKey: 'setting-once',
      requestId: 'concurrency-test',
      limit: null,
      expectedRevision: 1,
    });
    expect(await controls.read({ ...readInput, signal })).toEqual(settings);
    expect(persistence.readSettings).toHaveBeenCalledWith({
      workspaceId,
      workflowId,
      actorId,
      signal,
    });
  });
  it.each(['operator', 'viewer'] as const)(
    'permits %s read but never edit',
    async (role) => {
      const { persistence, controls } = fixture(role);
      expect(await controls.read(readInput)).toEqual(settings);
      await expect(controls.update(commandInput)).rejects.toMatchObject({
        code: 'resource.not_found',
      });
      expect(persistence.updateSettings).not.toHaveBeenCalled();
    },
  );
  it.each(['suspended', 'pending_deletion'])(
    'denies %s workspace even for owner',
    async (workspaceStatus) => {
      const { controls, authorization, persistence } = fixture();
      authorization.findAccess.mockResolvedValue({
        actorId,
        workspaceId,
        role: 'owner',
        membershipStatus: 'active',
        workspaceStatus,
      });
      await expect(controls.read(readInput)).rejects.toMatchObject({
        code: 'resource.not_found',
      });
      await expect(controls.update(commandInput)).rejects.toMatchObject({
        code: 'resource.not_found',
      });
      expect(persistence.readSettings).not.toHaveBeenCalled();
      expect(persistence.updateSettings).not.toHaveBeenCalled();
    },
  );
  it('denies missing membership and cross-workspace actor without persistence', async () => {
    const { controls, authorization, persistence } = fixture();
    authorization.findAccess.mockResolvedValue(undefined);
    await expect(controls.read(readInput)).rejects.toMatchObject({
      code: 'resource.not_found',
    });
    await expect(
      controls.update({ ...commandInput, routeWorkspaceId: workflowId }),
    ).rejects.toThrow();
    expect(persistence.readSettings).not.toHaveBeenCalled();
    expect(persistence.updateSettings).not.toHaveBeenCalled();
  });
  it('rejects speculative controls and invalid independent revisions before writes', async () => {
    const { controls, persistence } = fixture();
    for (const request of [
      { limit: 0, expectedRevision: 1 },
      { limit: 10_001, expectedRevision: 1 },
      { limit: 1, expectedRevision: 2_147_483_648 },
      { limit: null, expectedRevision: 0 },
      { limit: 1, expectedRevision: 1, overflow: 'skip' },
    ])
      await expect(
        controls.update({ ...commandInput, request }),
      ).rejects.toThrow();
    expect(persistence.updateSettings).not.toHaveBeenCalled();
  });
  it('cancels before authorization and does not issue reads or writes', async () => {
    const { controls, authorization, persistence } = fixture();
    const aborted = AbortSignal.abort();
    await expect(
      controls.read({ ...readInput, signal: aborted }),
    ).rejects.toThrow();
    await expect(
      controls.update({ ...commandInput, signal: aborted }),
    ).rejects.toThrow();
    expect(authorization.findAccess).not.toHaveBeenCalled();
    expect(persistence.readSettings).not.toHaveBeenCalled();
    expect(persistence.updateSettings).not.toHaveBeenCalled();
  });
  it('maps only typed command conflicts to safe409 metadata', () => {
    expect(
      mapWorkflowAuthoringError(
        new WorkflowConcurrencyRevisionConflictError(2),
      ),
    ).toMatchObject({
      code: 'workflow.concurrency_revision_conflict',
      details: { currentRevision: 2 },
    });
    expect(
      mapWorkflowAuthoringError(new WorkflowConcurrencyLimitExceededError(4)),
    ).toMatchObject({
      code: 'workflow.concurrency_limit_exceeded',
      details: { maximum: 4 },
    });
    expect(
      mapWorkflowAuthoringError(new WorkflowConcurrencyLimitUnavailableError()),
    ).toMatchObject({ code: 'workflow.concurrency_limit_unavailable' });
  });
});
describe('workflow concurrency HTTP boundary', () => {
  it('declares existing capability, session and CSRF guards and no-store responses', () => {
    // Metadata inspection does not invoke these unbound methods.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const read = WorkflowConcurrencyController.prototype.read;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const update = WorkflowConcurrencyController.prototype.update;
    expect(Reflect.getMetadata(GUARDS_METADATA, read)).toEqual([
      SessionAuthenticationGuard,
      WorkflowReadGuard,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, update)).toEqual([
      SessionAuthenticationGuard,
      WorkflowUpdateGuard,
      CsrfProtectionGuard,
    ]);
    for (const operation of [read, update])
      expect(Reflect.getMetadata(HEADERS_METADATA, operation)).toContainEqual({
        name: 'Cache-Control',
        value: 'private, no-store',
      });
  });
  it('validates exact command header and route identifiers', async () => {
    const { controls, persistence } = fixture();
    const controller = new WorkflowConcurrencyController(controls);
    const request = {
      headers: { 'idempotency-key': 'one,two' },
      identitySession: {
        userId: actorId,
        sessionId,
        expiresAt: new Date('2027-01-01'),
        clientMetadata: {},
      },
      requestId: 'concurrency-test',
    };
    await expect(
      controller.update(
        request,
        { workspaceId, workflowId },
        commandInput.request,
      ),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    await expect(
      controller.read(request, { workspaceId, workflowId: 'bad' }),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    expect(persistence.updateSettings).not.toHaveBeenCalled();
    expect(persistence.readSettings).not.toHaveBeenCalled();
    expect(
      await controller.update(
        { ...request, headers: { 'idempotency-key': 'single' } },
        { workspaceId, workflowId },
        commandInput.request,
      ),
    ).toEqual({ settings, replayed: true });
  });
});
