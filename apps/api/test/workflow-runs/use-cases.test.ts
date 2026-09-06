import { describe, expect, it, vi } from 'vitest';

import {
  authorizeWorkspace,
  createActorContext,
} from '../../src/workspaces/index.js';
import {
  CancelWorkflowRunUseCase,
  GetWorkflowRunUseCase,
  ReplayWorkflowRunUseCase,
  StartWorkflowRunUseCase,
  StreamRunEventsUseCase,
} from '../../src/workflow-runs/use-cases.js';
import type { WorkflowRunPersistence } from '../../src/workflow-runs/ports.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const workflowVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const now = new Date('2026-08-21T12:00:00.000Z');

const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId,
  requestId: 'request-42',
  traceId: 'trace-42',
});

function authorization(role: 'owner' | 'builder' | 'viewer' = 'owner') {
  return {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
    }),
  };
}

function run() {
  return {
    id: runId,
    workspaceId,
    workflowId,
    workflowVersionId,
    status: 'queued' as const,
    triggerType: 'manual' as const,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    deadlineAt: null,
    cancelRequestedAt: null,
  };
}

function persistence() {
  const start = vi
    .fn<WorkflowRunPersistence['start']>()
    .mockResolvedValue({ run: run(), replayed: false });
  const replay = vi
    .fn<WorkflowRunPersistence['replay']>()
    .mockResolvedValue({ run: run(), replayed: false });
  const get = vi
    .fn<WorkflowRunPersistence['get']>()
    .mockResolvedValue({ run: run(), nodes: [] });
  const cancel = vi
    .fn<WorkflowRunPersistence['cancel']>()
    .mockResolvedValue({ run: run(), alreadyRequested: false });
  return {
    store: { start, replay, get, cancel } satisfies WorkflowRunPersistence,
    start,
    replay,
    get,
    cancel,
  };
}

describe('workflow run application seams', () => {
  it('reuses guard authorization without repeating the access lookup', async () => {
    const fixture = persistence();
    const access = authorization();
    const authorizedWorkspace = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      capability: 'run:read',
      access,
      disclosure: 'not_found',
    });

    await new GetWorkflowRunUseCase(fixture.store, access).execute({
      actor,
      routeWorkspaceId: workspaceId,
      authorizedWorkspace,
      runId,
    });

    expect(access.findAccess).toHaveBeenCalledTimes(1);
  });

  it('authorizes and canonicalizes one idempotent start command', async () => {
    const fixture = persistence();
    const useCase = new StartWorkflowRunUseCase(fixture.store, authorization());

    const result = await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      idempotencyKey: 'run-start-42',
      input: { b: 2, a: 1 },
      deadlineAt: '2026-08-21T18:00:00.000Z',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    });

    expect(result.run.id).toBe(runId);
    expect(result.run.createdAt).toBe(now.toISOString());
    expect(result.replayed).toBe(false);
    const command = fixture.start.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      actorId,
      workspaceId,
      workflowId,
      scope: `workflow:${workflowId}:manual`,
      input: { b: 2, a: 1 },
      deadlineAt: new Date('2026-08-21T18:00:00.000Z'),
      requestId: 'request-42',
      traceId: 'trace-42',
    });
    expect(command?.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(command?.requestHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('keeps start and replay capabilities distinct', async () => {
    const fixture = persistence();
    const access = authorization('builder');

    await expect(
      new StartWorkflowRunUseCase(fixture.store, access).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        idempotencyKey: 'run-start-builder-42',
      }),
    ).resolves.toMatchObject({ replayed: false });

    await expect(
      new ReplayWorkflowRunUseCase(fixture.store, access).execute({
        actor,
        routeWorkspaceId: workspaceId,
        runId,
        workflowVersionId,
        idempotencyKey: 'run-replay-builder-42',
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });

    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.replay).not.toHaveBeenCalled();
  });

  it('rejects a route workspace mismatch before touching persistence', async () => {
    const fixture = persistence();
    const useCase = new StartWorkflowRunUseCase(fixture.store, authorization());

    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: '11111111-1111-4111-8111-111111111111',
        workflowId,
        idempotencyKey: 'run-start-42',
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it('authorizes and canonicalizes an explicit user replay command', async () => {
    const fixture = persistence();
    const useCase = new ReplayWorkflowRunUseCase(
      fixture.store,
      authorization(),
    );

    const result = await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      runId,
      workflowVersionId,
      idempotencyKey: 'run-replay-42',
      input: { b: 2, a: 1 },
      deadlineAt: '2026-08-21T18:00:00.000Z',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    });

    expect(result.run.id).toBe(runId);
    expect(result.replayed).toBe(false);
    expect(fixture.replay).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId,
        workspaceId,
        sourceRunId: runId,
        workflowVersionId,
        scope: `workflow:${runId}:replay`,
        input: { b: 2, a: 1 },
        deadlineAt: new Date('2026-08-21T18:00:00.000Z'),
        requestId: 'request-42',
        traceId: 'trace-42',
      }),
    );
    const command = fixture.replay.mock.calls[0]?.[0];
    expect(command?.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(command?.requestHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects a replay route workspace mismatch before touching persistence', async () => {
    const fixture = persistence();
    const useCase = new ReplayWorkflowRunUseCase(
      fixture.store,
      authorization(),
    );

    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: '11111111-1111-4111-8111-111111111111',
        runId,
        workflowVersionId,
        idempotencyKey: 'run-replay-42',
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(fixture.replay).not.toHaveBeenCalled();
  });

  it('requires the dedicated replay capability instead of run start access', async () => {
    const fixture = persistence();
    const useCase = new ReplayWorkflowRunUseCase(
      fixture.store,
      authorization('viewer'),
    );

    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        runId,
        workflowVersionId,
        idempotencyKey: 'run-replay-viewer-42',
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(fixture.replay).not.toHaveBeenCalled();
  });

  it.each(['suspended', 'pending_deletion'] as const)(
    'rejects replay in a %s workspace before persistence',
    async (workspaceStatus) => {
      const fixture = persistence();
      const access = authorization();
      access.findAccess.mockResolvedValue({
        actorId,
        workspaceId,
        role: 'owner',
        membershipStatus: 'active',
        workspaceStatus,
      });
      await expect(
        new ReplayWorkflowRunUseCase(fixture.store, access).execute({
          actor,
          routeWorkspaceId: workspaceId,
          runId,
          workflowVersionId,
          idempotencyKey: `replay-${workspaceStatus}`,
          input: {},
        }),
      ).rejects.toMatchObject({ code: 'resource.not_found' });
      expect(fixture.replay).not.toHaveBeenCalled();
    },
  );

  it('reads bounded run state only after run:read authorization', async () => {
    const fixture = persistence();
    const result = await new GetWorkflowRunUseCase(
      fixture.store,
      authorization('viewer'),
    ).execute({ actor, routeWorkspaceId: workspaceId, runId });

    expect(result.run.id).toBe(runId);
    expect(result.nodes).toEqual([]);
    expect(fixture.get).toHaveBeenCalledWith({ workspaceId, runId });
  });

  it('authorizes cancellation and forwards canonical actor/request context', async () => {
    const fixture = persistence();
    await new CancelWorkflowRunUseCase(fixture.store, authorization()).execute({
      actor,
      routeWorkspaceId: workspaceId,
      runId,
      reason: 'operator request',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    });

    expect(fixture.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId,
        workspaceId,
        runId,
        reason: 'operator request',
        requestId: 'request-42',
        traceId: 'trace-42',
      }),
    );
  });

  it('authorizes the stream, proves the run exists, and delegates the cursor', async () => {
    const fixture = persistence();
    const signal = new AbortController().signal;
    const frames = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield { id: 2, event: 'run.started', data: '{}' };
      },
    };
    const streamer = { stream: vi.fn().mockReturnValue(frames) };
    const result = await new StreamRunEventsUseCase(
      fixture.store,
      authorization('viewer'),
      streamer,
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      runId,
      lastEventId: 1,
      signal,
    });

    expect(fixture.get).toHaveBeenCalledWith({ workspaceId, runId });
    expect(streamer.stream).toHaveBeenCalledWith({
      workspaceId,
      runId,
      lastEventId: 1,
      signal,
    });
    expect(result).toBe(frames);
  });
});
