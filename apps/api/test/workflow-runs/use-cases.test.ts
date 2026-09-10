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
import type {
  WorkflowRunEventStreamer,
  WorkflowRunPersistence,
} from '../../src/workflow-runs/ports.js';

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

  it.each(['start', 'replay'] as const)(
    'rejects an invalid %s deadline before persistence',
    async (operation) => {
      const fixture = persistence();
      const common = {
        actor,
        routeWorkspaceId: workspaceId,
        idempotencyKey: `invalid-${operation}-deadline`,
        deadlineAt: 'not-a-date',
      };

      const execution =
        operation === 'start'
          ? new StartWorkflowRunUseCase(fixture.store, authorization()).execute(
              { ...common, workflowId },
            )
          : new ReplayWorkflowRunUseCase(
              fixture.store,
              authorization(),
            ).execute({
              ...common,
              runId,
              workflowVersionId,
              input: {},
            });

      await expect(execution).rejects.toThrow('deadline is invalid');
      expect(fixture.start).not.toHaveBeenCalled();
      expect(fixture.replay).not.toHaveBeenCalled();
    },
  );

  it('supports omitted and explicit request metadata across start, replay, and cancel', async () => {
    const fixture = persistence();
    const actorWithoutTrace = createActorContext({
      actorId,
      workspaceId,
      sessionId,
      requestId: 'actor-request',
    });

    await new StartWorkflowRunUseCase(fixture.store, authorization()).execute({
      actor: actorWithoutTrace,
      routeWorkspaceId: workspaceId,
      workflowId,
      idempotencyKey: 'start-minimal',
      requestId: 'start-request',
    });
    await new ReplayWorkflowRunUseCase(fixture.store, authorization()).execute({
      actor: actorWithoutTrace,
      routeWorkspaceId: workspaceId,
      runId,
      workflowVersionId,
      idempotencyKey: 'replay-minimal',
      input: null,
      requestId: 'replay-request',
      traceId: 'replay-trace',
    });
    await new CancelWorkflowRunUseCase(fixture.store, authorization()).execute({
      actor: actorWithoutTrace,
      routeWorkspaceId: workspaceId,
      runId,
      requestId: 'cancel-request',
      traceId: 'cancel-trace',
    });
    await new CancelWorkflowRunUseCase(fixture.store, authorization()).execute({
      actor: actorWithoutTrace,
      routeWorkspaceId: workspaceId,
      runId,
    });

    expect(fixture.start).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'start-request' }),
    );
    expect(fixture.start.mock.calls[0]?.[0]).not.toHaveProperty('traceId');
    expect(fixture.replay).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'replay-request',
        traceId: 'replay-trace',
      }),
    );
    expect(fixture.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'cancel-request',
        traceId: 'cancel-trace',
      }),
    );
    expect(fixture.cancel.mock.calls[0]?.[0]).not.toHaveProperty('reason');
    expect(fixture.cancel.mock.calls[0]?.[0]).not.toHaveProperty('traceparent');
    expect(fixture.cancel.mock.calls[1]?.[0]).not.toHaveProperty('traceId');
  });

  it.each(['get', 'stream'] as const)(
    'reports a missing run before %s behavior proceeds',
    async (operation) => {
      const fixture = persistence();
      fixture.get.mockResolvedValue(undefined);

      const execution =
        operation === 'get'
          ? new GetWorkflowRunUseCase(
              fixture.store,
              authorization('viewer'),
            ).execute({ actor, routeWorkspaceId: workspaceId, runId })
          : new StreamRunEventsUseCase(fixture.store, authorization('viewer'), {
              stream: vi.fn(),
            }).execute({
              actor,
              routeWorkspaceId: workspaceId,
              runId,
              lastEventId: 0,
              sessionExpiresAt: new Date(Date.now() + 60_000),
              reauthorizeSession: vi.fn(),
              abortStream: vi.fn(),
              signal: new AbortController().signal,
            });

      await expect(execution).rejects.toMatchObject({
        name: 'WorkflowRunNotFoundError',
      });
    },
  );

  it('serializes non-null run and node lifecycle timestamps', async () => {
    const fixture = persistence();
    fixture.get.mockResolvedValue({
      run: {
        ...run(),
        startedAt: now,
        completedAt: now,
        deadlineAt: now,
        cancelRequestedAt: now,
      },
      nodes: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          nodeId: 'node-1',
          invocationKey: 'node-1',
          status: 'succeeded',
          currentAttemptNumber: 1,
          startedAt: now,
          completedAt: now,
          resumeAt: now,
          safeErrorCode: null,
        },
      ],
    });

    const result = await new GetWorkflowRunUseCase(
      fixture.store,
      authorization('viewer'),
    ).execute({ actor, routeWorkspaceId: workspaceId, runId });

    expect(result.run.startedAt).toBe(now.toISOString());
    expect(result.nodes[0]).toMatchObject({
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      resumeAt: now.toISOString(),
    });
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
    const streamer = {
      stream: vi
        .fn<WorkflowRunEventStreamer['stream']>()
        .mockReturnValue(frames),
    };
    const result = await new StreamRunEventsUseCase(
      fixture.store,
      authorization('viewer'),
      streamer,
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      runId,
      lastEventId: 1,
      sessionExpiresAt: new Date(Date.now() + 60_000),
      reauthorizeSession: vi.fn().mockResolvedValue({
        userId: actorId,
        sessionId,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      abortStream: vi.fn(),
      signal,
    });

    expect(fixture.get).toHaveBeenCalledWith({ workspaceId, runId });
    expect(streamer.stream).toHaveBeenCalledOnce();
    expect(streamer.stream.mock.calls[0]?.[0]).toMatchObject({
      workspaceId,
      runId,
      lastEventId: 1,
    });
    expect(streamer.stream.mock.calls[0]?.[0].signal).not.toBe(signal);
    await expect(result[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      done: false,
      value: { id: 2 },
    });
  });

  it('reauthorizes before later frames and stops after membership removal', async () => {
    const fixture = persistence();
    const access = authorization('viewer');
    const later = Promise.withResolvers<undefined>();
    let cleanedUp = false;
    const streamer = {
      stream: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          try {
            yield { id: 1, event: 'run.started', data: '{}' };
            await later.promise;
            yield { id: 2, event: 'run.succeeded', data: '{}' };
          } finally {
            cleanedUp = true;
          }
        },
      }),
    };
    const frames = await new StreamRunEventsUseCase(
      fixture.store,
      access,
      streamer,
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      runId,
      lastEventId: 0,
      sessionExpiresAt: new Date(Date.now() + 60_000),
      signal: new AbortController().signal,
      abortStream: vi.fn(),
      reauthorizeSession: vi.fn().mockResolvedValue({
        userId: actorId,
        sessionId,
        expiresAt: new Date(Date.now() + 60_000),
        clientMetadata: {},
      }),
    });
    const iterator = frames[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: 1 },
    });
    access.findAccess.mockResolvedValue({
      actorId,
      workspaceId,
      role: 'viewer',
      membershipStatus: 'suspended',
      workspaceStatus: 'active',
    });
    later.resolve(undefined);

    await expect(iterator.next()).rejects.toMatchObject({
      code: 'resource.not_found',
    });
    expect(access.findAccess).toHaveBeenCalledTimes(3);
    expect(cleanedUp).toBe(true);
  });

  it.each(['revoked', 'expired', 'workspace_lifecycle'] as const)(
    'stops before a later frame after %s access loss',
    async (transition) => {
      const fixture = persistence();
      const access = authorization('viewer');
      const later = Promise.withResolvers<undefined>();
      const reauthorizeSession = vi.fn().mockResolvedValue({
        userId: actorId,
        sessionId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const frames = await new StreamRunEventsUseCase(fixture.store, access, {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield { id: 1, event: 'run.started', data: '{}' };
            await later.promise;
            yield { id: 2, event: 'run.succeeded', data: '{}' };
          },
        }),
      }).execute({
        actor,
        routeWorkspaceId: workspaceId,
        runId,
        lastEventId: 0,
        sessionExpiresAt: new Date(Date.now() + 60_000),
        signal: new AbortController().signal,
        abortStream: vi.fn(),
        reauthorizeSession,
      });
      const iterator = frames[Symbol.asyncIterator]();
      await iterator.next();

      if (transition === 'revoked') {
        reauthorizeSession.mockRejectedValue(new Error('session revoked'));
      } else if (transition === 'expired') {
        reauthorizeSession.mockResolvedValue({
          userId: actorId,
          sessionId,
          expiresAt: new Date(Date.now() - 1),
        });
      } else {
        access.findAccess.mockResolvedValue({
          actorId,
          workspaceId,
          role: 'viewer',
          membershipStatus: 'active',
          workspaceStatus: 'purging',
        });
      }
      later.resolve(undefined);

      await expect(iterator.next()).rejects.toThrow();
    },
  );

  it('reauthorizes an idle stream at the bounded lifetime deadline', async () => {
    vi.useFakeTimers();
    try {
      const fixture = persistence();
      const access = authorization('viewer');
      let producerCleanedUp = false;
      let producerSignal: AbortSignal | undefined;
      const frames = await new StreamRunEventsUseCase(fixture.store, access, {
        stream: ({ signal }) => {
          producerSignal = signal;
          return {
            async *[Symbol.asyncIterator]() {
              try {
                yield* [];
                await new Promise<void>((resolve) => {
                  if (signal.aborted) resolve();
                  else
                    signal.addEventListener(
                      'abort',
                      () => {
                        resolve();
                      },
                      { once: true },
                    );
                });
              } finally {
                producerCleanedUp = true;
              }
            },
          };
        },
      }).execute({
        actor,
        routeWorkspaceId: workspaceId,
        runId,
        lastEventId: 0,
        signal: new AbortController().signal,
        abortStream: vi.fn(),
        sessionExpiresAt: new Date(Date.now() + 5_000),
        reauthorizeSession: vi
          .fn()
          .mockRejectedValue(new Error('session expired')),
      });
      const next = frames[Symbol.asyncIterator]().next();
      const rejection = expect(next).rejects.toThrow('session expired');

      await vi.advanceTimersByTimeAsync(5_000);

      await rejection;
      expect(producerSignal?.aborted).toBe(true);
      expect(producerCleanedUp).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not await a stalled reauthorization lookup during explicit cleanup', async () => {
    vi.useFakeTimers();
    const requestController = new AbortController();
    let workspaceLookupSignal: AbortSignal | undefined;
    const authorizedSession = {
      userId: actorId,
      sessionId,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const reauthorizeSession = vi.fn().mockResolvedValue(authorizedSession);
    const activeAccess = {
      actorId,
      workspaceId,
      role: 'viewer' as const,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
    };
    const stalledLookup = Promise.withResolvers<typeof activeAccess>();
    const access = {
      findAccess: vi
        .fn()
        .mockResolvedValueOnce(activeAccess)
        .mockResolvedValueOnce(activeAccess)
        .mockImplementation((query: Readonly<{ signal?: AbortSignal }>) => {
          workspaceLookupSignal = query.signal;
          return stalledLookup.promise;
        }),
    };
    let returning: Promise<unknown> | undefined;
    try {
      const fixture = persistence();
      const frames = await new StreamRunEventsUseCase(fixture.store, access, {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield { id: 1, event: 'run.started', data: '{}' };
          },
        }),
      }).execute({
        actor,
        routeWorkspaceId: workspaceId,
        runId,
        lastEventId: 0,
        signal: requestController.signal,
        abortStream: (reason?: unknown) => {
          requestController.abort(reason);
        },
        sessionExpiresAt: authorizedSession.expiresAt,
        reauthorizeSession,
      });
      const iterator = frames[Symbol.asyncIterator]();
      await iterator.next();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reauthorizeSession).toHaveBeenCalledTimes(2);
      expect(access.findAccess).toHaveBeenCalledTimes(3);

      requestController.abort();
      const returningNow =
        iterator.return?.() ??
        Promise.resolve({ done: true, value: undefined });
      returning = returningNow;
      const cleanup = Promise.race([
        returningNow.then(() => 'settled' as const),
        new Promise<'timed_out'>((resolve) => {
          setTimeout(() => {
            resolve('timed_out');
          }, 1);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(1);

      expect(await cleanup).toBe('settled');
      expect(workspaceLookupSignal?.aborted).toBe(true);
    } finally {
      stalledLookup.resolve(activeAccess);
      await vi.advanceTimersByTimeAsync(1);
      await returning;
      vi.useRealTimers();
    }
  });
});
