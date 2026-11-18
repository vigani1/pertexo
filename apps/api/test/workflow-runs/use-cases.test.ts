import { describe, expect, it, vi } from 'vitest';
import {
  StartWorkflowRunService,
  ReplayWorkflowRunService,
  StreamRunEventsService,
  WorkflowRunNotFoundError as WorkflowRunNotFoundError3,
} from '../../src/workflow-runs/workflow-runs.service.js';
import {
  actorId,
  workspaceId,
  workflowId,
  runId,
  actor,
  authorization,
  persistence,
  sessionId,
  workflowVersionId,
} from './workflow-run-commands.fixture.js';
import type { WorkflowRunEventStreamer } from '../../src/workflow-runs/ports.js';

describe('workflow run application seams', () => {
  // Real-stack tests own starts, replays, reads, cancels, cursors and the
  // stream's happy path. What stays: authority checked again on a retried
  // start and kept apart from replay (no role fixture on the real run
  // stack), and a stream losing access between two frames, which needs a
  // frame produced at a chosen moment.

  it('checks current start authority before recovering an accepted command', async () => {
    const fixture = persistence();
    const input = {
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      idempotencyKey: 'accepted-run-recovery',
    };
    await new StartWorkflowRunService(fixture.store, authorization()).execute(
      input,
    );
    await expect(
      new StartWorkflowRunService(
        fixture.store,
        authorization('viewer'),
      ).execute(input),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(fixture.start).toHaveBeenCalledTimes(1);
  });

  it('keeps start and replay capabilities distinct', async () => {
    const fixture = persistence();
    const access = authorization('builder');

    await expect(
      new StartWorkflowRunService(fixture.store, access).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        idempotencyKey: 'run-start-builder-42',
      }),
    ).resolves.toMatchObject({ replayed: false });

    await expect(
      new ReplayWorkflowRunService(fixture.store, access).execute({
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

  it('requires the dedicated replay capability instead of run start access', async () => {
    const fixture = persistence();
    const service = new ReplayWorkflowRunService(
      fixture.store,
      authorization('viewer'),
    );

    await expect(
      service.execute({
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

  it('does not acquire the producer or start authorization when returned before the first read', async () => {
    const fixture = persistence();
    const stream = vi.fn<WorkflowRunEventStreamer['stream']>();
    const reauthorizeSession = vi.fn();
    const frames = await new StreamRunEventsService(
      fixture.store,
      authorization('viewer'),
      { stream },
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      runId,
      lastEventId: 0,
      sessionExpiresAt: new Date(Date.now() + 60_000),
      reauthorizeSession,
      abortStream: vi.fn(),
      signal: new AbortController().signal,
    });

    const iterator = frames[Symbol.asyncIterator]();
    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(stream).not.toHaveBeenCalled();
    expect(reauthorizeSession).not.toHaveBeenCalled();
  });

  it.each(['stream factory', 'iterator factory'] as const)(
    'contains a throwing %s before authorization lifetime starts',
    async (failurePoint) => {
      const fixture = persistence();
      const failure = new Error(`${failurePoint} failed`);
      const reauthorizeSession = vi.fn();
      const stream = vi.fn<WorkflowRunEventStreamer['stream']>(() => {
        if (failurePoint === 'stream factory') throw failure;
        return {
          [Symbol.asyncIterator]: () => {
            throw failure;
          },
        };
      });
      const frames = await new StreamRunEventsService(
        fixture.store,
        authorization('viewer'),
        { stream },
      ).execute({
        actor,
        routeWorkspaceId: workspaceId,
        runId,
        lastEventId: 0,
        sessionExpiresAt: new Date(Date.now() + 60_000),
        reauthorizeSession,
        abortStream: vi.fn(),
        signal: new AbortController().signal,
      });

      await expect(frames[Symbol.asyncIterator]().next()).rejects.toBe(failure);
      expect(stream).toHaveBeenCalledOnce();
      expect(reauthorizeSession).not.toHaveBeenCalled();
    },
  );

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
    const frames = await new StreamRunEventsService(
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

  it('stops before later frames after folder access is revoked while membership stays active', async () => {
    const fixture = persistence();
    const canRead = vi.fn().mockResolvedValue(true);
    fixture.store.canRead = canRead;
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
    const frames = await new StreamRunEventsService(
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
    canRead.mockResolvedValue(false);
    later.resolve(undefined);

    await expect(iterator.next()).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError3,
    );
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
      const frames = await new StreamRunEventsService(fixture.store, access, {
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
      const frames = await new StreamRunEventsService(fixture.store, access, {
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
      const frames = await new StreamRunEventsService(fixture.store, access, {
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
