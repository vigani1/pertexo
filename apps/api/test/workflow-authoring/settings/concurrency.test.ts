import type { Role } from '@pertexo/policy';
import { problemResult } from '../../support/problem.js';
import { toProblem } from '../../../src/problems/api-problem-registry.js';
import { authoringFailure } from '../../../src/problems/context/normalize-context-errors.js';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowConcurrencyStore } from '@pertexo/core/authoring';
import {
  WorkflowConcurrencyRevisionConflictError,
  WorkflowConcurrencyLimitExceededError,
  WorkflowConcurrencyLimitUnavailableError,
} from '@pertexo/core/authoring';
import { WorkflowConcurrencyUseCase } from '../../../src/workflow-authoring/settings/concurrency.js';

import { createActorContext } from '../../../src/authorization/index.js';

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
function fixture(role: Role = 'owner') {
  const persistence = {
    readSettings: vi.fn().mockResolvedValue(settings),
    updateSettings: vi.fn().mockResolvedValue({ settings, replayed: true }),
  } satisfies WorkflowConcurrencyStore;
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
      await expect(
        problemResult(controls.update(commandInput), authoringFailure),
      ).rejects.toMatchObject({
        code: 'resource.not_found',
      });
      expect(persistence.updateSettings).not.toHaveBeenCalled();
    },
  );
  it('reads but does not change a suspended workspace', async () => {
    const { controls, authorization, persistence } = fixture();
    authorization.findAccess.mockResolvedValue({
      actorId,
      workspaceId,
      role: 'owner',
      membershipStatus: 'active',
      workspaceStatus: 'suspended',
    });
    await controls.read(readInput);
    expect(persistence.readSettings).toHaveBeenCalledOnce();
    await expect(
      problemResult(controls.update(commandInput), authoringFailure),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(persistence.updateSettings).not.toHaveBeenCalled();
  });
  it.each(['pending_deletion'])(
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
      await expect(
        problemResult(controls.read(readInput), authoringFailure),
      ).rejects.toMatchObject({
        code: 'resource.not_found',
      });
      await expect(
        problemResult(controls.update(commandInput), authoringFailure),
      ).rejects.toMatchObject({
        code: 'resource.not_found',
      });
      expect(persistence.readSettings).not.toHaveBeenCalled();
      expect(persistence.updateSettings).not.toHaveBeenCalled();
    },
  );
  it('denies missing membership and cross-workspace actor without persistence', async () => {
    const { controls, authorization, persistence } = fixture();
    authorization.findAccess.mockResolvedValue(undefined);
    await expect(
      problemResult(controls.read(readInput), authoringFailure),
    ).rejects.toMatchObject({
      code: 'resource.not_found',
    });
    await expect(
      controls.update({ ...commandInput, routeWorkspaceId: workflowId }),
    ).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    expect(persistence.readSettings).not.toHaveBeenCalled();
    expect(persistence.updateSettings).not.toHaveBeenCalled();
  });
  it('cancels before authorization and does not issue reads or writes', async () => {
    const { controls, authorization, persistence } = fixture();
    const aborted = AbortSignal.abort();
    await expect(
      controls.read({ ...readInput, signal: aborted }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      controls.update({ ...commandInput, signal: aborted }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(authorization.findAccess).not.toHaveBeenCalled();
    expect(persistence.readSettings).not.toHaveBeenCalled();
    expect(persistence.updateSettings).not.toHaveBeenCalled();
  });
  it('maps only typed command conflicts to safe409 metadata', () => {
    expect(
      toProblem(
        authoringFailure(new WorkflowConcurrencyRevisionConflictError(2)),
      ),
    ).toMatchObject({
      code: 'workflow.concurrency_revision_conflict',
      details: { currentRevision: 2 },
    });
    expect(
      toProblem(authoringFailure(new WorkflowConcurrencyLimitExceededError(4))),
    ).toMatchObject({
      code: 'workflow.concurrency_limit_exceeded',
      details: { maximum: 4 },
    });
    expect(
      toProblem(
        authoringFailure(new WorkflowConcurrencyLimitUnavailableError()),
      ),
    ).toMatchObject({ code: 'workflow.concurrency_limit_unavailable' });
  });
});
