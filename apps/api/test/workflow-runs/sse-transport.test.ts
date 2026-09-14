import { EventEmitter, getEventListeners } from 'node:events';

import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { createWorkflowRunEventStreamer } from '../../src/workflow-runs/event-streamer.js';
import { createActorContext } from '../../src/workspaces/index.js';
import { ApiDrainState } from '../../src/platform/health/drain-state.js';
import { writeSseFrames } from '../../src/workflow-runs/sse-transport.js';
import {
  createStreamAuthorizationLifetime,
  nextFrameOrAuthorizationLoss,
} from '../../src/workflow-runs/sse-authorization-lifetime.js';
import {
  streamCleanupCompletion,
  StreamCleanupIncompleteError,
} from '../../src/workflow-runs/stream-cleanup.js';
import { StreamRunEventsUseCase } from '../../src/workflow-runs/use-cases.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function frame(id: number) {
  return {
    id,
    event: 'run.started',
    data: JSON.stringify({
      sequence: id,
      type: 'run.started',
      createdAt: '2026-08-21T12:00:00.000Z',
      payload: { schemaVersion: 1 },
    }),
    visibilityPath: 'initial_backfill' as const,
  };
}

function nestedAggregateErrors(error: unknown): readonly unknown[] {
  if (!(error instanceof AggregateError)) return [error];
  return [
    error,
    ...error.errors.flatMap((nested: unknown) => nestedAggregateErrors(nested)),
  ];
}

describe('workflow run SSE transport', () => {
  it.each([
    { label: 'more than five seconds', remainingMs: 60_000, advanceMs: 4_000 },
    { label: 'exactly one second', remainingMs: 1_000, advanceMs: 0 },
    { label: '999 milliseconds', remainingMs: 999, advanceMs: 0 },
  ] as const)(
    'performs one idle refresh without spinning for a fixed expiry $label away',
    async ({ remainingMs, advanceMs }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
      const expiresAt = new Date(Date.now() + remainingMs);
      const reauthorizeSession = vi.fn().mockResolvedValue({
        userId: actorId,
        sessionId,
        expiresAt,
      });
      const access = {
        findAccess: vi.fn().mockResolvedValue({
          actorId,
          workspaceId,
          role: 'viewer' as const,
          membershipStatus: 'active' as const,
          workspaceStatus: 'active' as const,
        }),
      };
      const abortStream = vi.fn();
      const lifetime = createStreamAuthorizationLifetime(
        {
          actor: createActorContext({
            actorId,
            workspaceId,
            sessionId,
            requestId: 'fixed-expiry',
          }),
          routeWorkspaceId: workspaceId,
          sessionExpiresAt: expiresAt,
          reauthorizeSession,
          abortStream,
          signal: new AbortController().signal,
        },
        access,
        5_000,
        new AbortController(),
      );
      try {
        await vi.advanceTimersByTimeAsync(advanceMs);
        expect(reauthorizeSession).toHaveBeenCalledOnce();
        expect(access.findAccess).toHaveBeenCalledOnce();

        if (remainingMs > 5_000) {
          await vi.advanceTimersByTimeAsync(3_999);
          expect(reauthorizeSession).toHaveBeenCalledOnce();
          expect(abortStream).not.toHaveBeenCalled();
          expect(lifetime.authorizationLost.aborted).toBe(false);
        } else {
          const untilExpiry = remainingMs - advanceMs;
          if (untilExpiry > 1) {
            await vi.advanceTimersByTimeAsync(untilExpiry - 1);
            expect(reauthorizeSession).toHaveBeenCalledOnce();
            expect(abortStream).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
          }
          expect(lifetime.authorizationLost.aborted).toBe(true);
          expect(abortStream).toHaveBeenCalledOnce();
        }
      } finally {
        await lifetime.stop();
        vi.useRealTimers();
      }
    },
  );

  it('does not spin when the verified session is already at exact expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
    const expiresAt = new Date(Date.now());
    const reauthorizeSession = vi.fn().mockResolvedValue({
      userId: actorId,
      sessionId,
      expiresAt,
    });
    const abortStream = vi.fn();
    const lifetime = createStreamAuthorizationLifetime(
      {
        actor: createActorContext({
          actorId,
          workspaceId,
          sessionId,
          requestId: 'exact-expiry',
        }),
        routeWorkspaceId: workspaceId,
        sessionExpiresAt: expiresAt,
        reauthorizeSession,
        abortStream,
        signal: new AbortController().signal,
      },
      { findAccess: vi.fn() },
      5_000,
      new AbortController(),
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(reauthorizeSession.mock.calls.length).toBeLessThanOrEqual(1);
      expect(lifetime.authorizationLost.aborted).toBe(true);
      expect(abortStream).toHaveBeenCalledOnce();
    } finally {
      await lifetime.stop();
      vi.useRealTimers();
    }
  });

  it('schedules a later idle refresh only when authorization verifies a newer expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
    const initialExpiry = new Date(Date.now() + 999);
    const extendedExpiry = new Date(Date.now() + 60_000);
    const reauthorizeSession = vi.fn().mockResolvedValue({
      userId: actorId,
      sessionId,
      expiresAt: extendedExpiry,
    });
    const access = {
      findAccess: vi.fn().mockResolvedValue({
        actorId,
        workspaceId,
        role: 'viewer' as const,
        membershipStatus: 'active' as const,
        workspaceStatus: 'active' as const,
      }),
    };
    const lifetime = createStreamAuthorizationLifetime(
      {
        actor: createActorContext({
          actorId,
          workspaceId,
          sessionId,
          requestId: 'extended-expiry',
        }),
        routeWorkspaceId: workspaceId,
        sessionExpiresAt: initialExpiry,
        reauthorizeSession,
        abortStream: vi.fn(),
        signal: new AbortController().signal,
      },
      access,
      5_000,
      new AbortController(),
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(reauthorizeSession).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3_999);
      expect(reauthorizeSession).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(reauthorizeSession).toHaveBeenCalledTimes(2);
      expect(access.findAccess).toHaveBeenCalledTimes(2);
    } finally {
      await lifetime.stop();
      vi.useRealTimers();
    }
  });

  it('returns authorization loss without reading when already revoked', async () => {
    const authorizationLost = new AbortController();
    const reason = new Error('revoked');
    authorizationLost.abort(reason);
    const next = vi.fn();

    await expect(
      nextFrameOrAuthorizationLoss({ next }, authorizationLost.signal),
    ).resolves.toEqual({ kind: 'authorization_lost', error: reason });
    expect(next).not.toHaveBeenCalled();
  });

  it('observes authorization loss that races listener registration', async () => {
    const authorizationLost = new AbortController();
    const reason = new Error('revoked while subscribing');
    const originalAdd = authorizationLost.signal.addEventListener.bind(
      authorizationLost.signal,
    );
    vi.spyOn(authorizationLost.signal, 'addEventListener').mockImplementation(
      (...arguments_) => {
        originalAdd(...arguments_);
        authorizationLost.abort(reason);
      },
    );

    await expect(
      nextFrameOrAuthorizationLoss(
        { next: () => new Promise<IteratorResult<never>>(() => undefined) },
        authorizationLost.signal,
      ),
    ).resolves.toEqual({ kind: 'authorization_lost', error: reason });
  });

  it.each([
    {
      label: 'different user',
      session: {
        userId: '11111111-1111-4111-8111-111111111111',
        sessionId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    },
    {
      label: 'different session',
      session: {
        userId: actorId,
        sessionId: '11111111-1111-4111-8111-111111111111',
        expiresAt: new Date(Date.now() + 60_000),
      },
    },
    {
      label: 'invalid expiry',
      session: {
        userId: actorId,
        sessionId,
        expiresAt: new Date(Number.NaN),
      },
    },
    {
      label: 'expired session',
      session: {
        userId: actorId,
        sessionId,
        expiresAt: new Date(Date.now() - 1),
      },
    },
  ])('revokes a refreshed session with $label', async ({ session }) => {
    const abortStream = vi.fn();
    const lifetimeController = new AbortController();
    const lifetime = createStreamAuthorizationLifetime(
      {
        actor: createActorContext({
          actorId,
          workspaceId,
          sessionId,
          requestId: 'request-42',
        }),
        routeWorkspaceId: workspaceId,
        sessionExpiresAt: new Date(Date.now() + 60_000),
        reauthorizeSession: vi.fn().mockResolvedValue(session),
        abortStream,
        signal: new AbortController().signal,
      },
      { findAccess: vi.fn() },
      60_000,
      lifetimeController,
    );

    await expect(lifetime.reauthorize()).rejects.toThrow(
      'session is no longer authorized',
    );
    expect(lifetime.authorizationLost.aborted).toBe(true);
    expect(abortStream).toHaveBeenCalledOnce();
    await lifetime.stop();
  });

  it('coalesces concurrent explicit authorization refreshes', async () => {
    const deferred = Promise.withResolvers<{
      userId: string;
      sessionId: string;
      expiresAt: Date;
    }>();
    const reauthorizeSession = vi.fn(() => deferred.promise);
    const access = {
      findAccess: vi.fn().mockResolvedValue({
        actorId,
        workspaceId,
        role: 'viewer' as const,
        membershipStatus: 'active' as const,
        workspaceStatus: 'active' as const,
      }),
    };
    const lifetime = createStreamAuthorizationLifetime(
      {
        actor: createActorContext({
          actorId,
          workspaceId,
          sessionId,
          requestId: 'request-42',
        }),
        routeWorkspaceId: workspaceId,
        sessionExpiresAt: new Date(Date.now() + 60_000),
        reauthorizeSession,
        abortStream: vi.fn(),
        signal: new AbortController().signal,
      },
      access,
      60_000,
      new AbortController(),
    );

    const first = lifetime.reauthorize();
    const second = lifetime.reauthorize();
    expect(reauthorizeSession).toHaveBeenCalledOnce();
    deferred.resolve({
      userId: actorId,
      sessionId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await Promise.all([first, second]);

    expect(access.findAccess).toHaveBeenCalledOnce();
    await lifetime.stop();
  });

  it('stops without revoking when an explicit refresh is still pending', async () => {
    const deferred = Promise.withResolvers<{
      userId: string;
      sessionId: string;
      expiresAt: Date;
    }>();
    const abortStream = vi.fn();
    const lifetime = createStreamAuthorizationLifetime(
      {
        actor: createActorContext({
          actorId,
          workspaceId,
          sessionId,
          requestId: 'request-42',
        }),
        routeWorkspaceId: workspaceId,
        sessionExpiresAt: new Date(Date.now() + 60_000),
        reauthorizeSession: vi.fn(() => deferred.promise),
        abortStream,
        signal: new AbortController().signal,
      },
      { findAccess: vi.fn() },
      60_000,
      new AbortController(),
    );
    const refreshing = lifetime.reauthorize();

    await lifetime.stop();
    await expect(refreshing).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortStream).not.toHaveBeenCalled();

    deferred.resolve({
      userId: actorId,
      sessionId,
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  it('removes the losing authorization observer after every produced frame', async () => {
    const authorizationLost = new AbortController();
    const add = vi.spyOn(authorizationLost.signal, 'addEventListener');
    const remove = vi.spyOn(authorizationLost.signal, 'removeEventListener');
    let sequence = 0;
    const iterator: AsyncIterator<number> = {
      next: () =>
        Promise.resolve({ done: false as const, value: (sequence += 1) }),
    };

    for (let expected = 1; expected <= 10_000; expected += 1) {
      await expect(
        nextFrameOrAuthorizationLoss(iterator, authorizationLost.signal),
      ).resolves.toMatchObject({
        kind: 'frame',
        result: { done: false, value: expected },
      });
    }

    expect(add).toHaveBeenCalledTimes(10_000);
    expect(remove).toHaveBeenCalledTimes(10_000);
  });

  it('does not read ahead while the transport is backpressured', async () => {
    let produced = 0;
    const frames = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        for (let id = 1; id <= 1_000; id += 1) {
          produced += 1;
          yield frame(id);
        }
      },
    };
    const destination = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn<(chunk: string) => boolean>>;
      end: ReturnType<typeof vi.fn<() => void>>;
      destroy: ReturnType<typeof vi.fn<(error?: Error) => void>>;
      destroyed: boolean;
    };
    destination.write = vi
      .fn<(chunk: string) => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    destination.end = vi.fn<() => void>();
    destination.destroy = vi.fn<(error?: Error) => void>();
    destination.destroyed = false;
    const writing = writeSseFrames(
      frames,
      destination,
      new AbortController(),
      { recordFirstEligibleFrame: vi.fn() },
      'initial_backfill',
    );

    await vi.waitFor(() => {
      expect(destination.write).toHaveBeenCalledOnce();
    });
    expect(produced).toBe(1);
    destination.emit('drain');
    await writing;

    expect(produced).toBe(1_000);
    expect(destination.write).toHaveBeenCalledTimes(1_000);
    expect(
      destination.write.mock.calls.map(([chunk]) =>
        Number(/^id: (\d+)/u.exec(chunk)?.[1]),
      ),
    ).toEqual(Array.from({ length: 1_000 }, (_, index) => index + 1));
    expect(destination.end).toHaveBeenCalledOnce();
  });

  it('stops a blocked producer on disconnect and leaves replay to the durable cursor', async () => {
    let returned = false;
    let produced = 0;
    const frames = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          produced += 1;
          return Promise.resolve({
            done: false as const,
            value: frame(produced),
          });
        },
        return: () => {
          returned = true;
          return Promise.resolve({ done: true as const, value: undefined });
        },
      }),
    };
    const destination = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => boolean;
      end: () => void;
      destroy: (error?: Error) => void;
      destroyed: boolean;
    };
    destination.write = vi
      .fn<(chunk: string) => boolean>()
      .mockReturnValue(false);
    destination.end = vi.fn<() => void>();
    destination.destroy = vi.fn<(error?: Error) => void>();
    destination.destroyed = false;
    const controller = new AbortController();
    const writing = writeSseFrames(
      frames,
      destination,
      controller,
      { recordFirstEligibleFrame: vi.fn() },
      'reconnect_backfill',
    );
    await vi.waitFor(() => {
      expect(destination.listenerCount('drain')).toBe(1);
    });

    controller.abort();
    await writing;

    expect(produced).toBe(1);
    expect(returned).toBe(true);
    expect(destination.listenerCount('drain')).toBe(0);
    expect(destination.listenerCount('close')).toBe(0);
    expect(destination.listenerCount('error')).toBe(0);
    expect(destination.end).toHaveBeenCalledOnce();
  });

  it('preserves producer and cleanup failures while still ending the destination', async () => {
    const readError = new Error('producer read failed');
    const returnError = new Error('producer cleanup failed');
    const endError = new Error('destination end failed');
    const frames = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Promise.reject<IteratorResult<ReturnType<typeof frame>>>(readError),
        return: () =>
          Promise.reject<IteratorResult<ReturnType<typeof frame>>>(returnError),
      }),
    };
    const destination = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => boolean;
      end: ReturnType<typeof vi.fn<() => void>>;
      destroy: (error?: Error) => void;
      destroyed: boolean;
    };
    destination.write = vi.fn().mockReturnValue(true);
    destination.end = vi.fn(() => {
      throw endError;
    });
    destination.destroy = vi.fn();
    destination.destroyed = false;

    const failure = await writeSseFrames(
      frames,
      destination,
      new AbortController(),
      { recordFirstEligibleFrame: vi.fn() },
      'live_wakeup',
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      readError,
      returnError,
      endError,
    ]);
    expect(destination.end).toHaveBeenCalledOnce();
  });

  it('ends transport within one budget while retaining noncooperative producer cleanup', async () => {
    vi.useFakeTimers();
    const readError = new Error('producer read failed');
    const heldReturn = Promise.withResolvers<IteratorResult<never>>();
    const returnIterator = vi.fn(() => heldReturn.promise);
    const frames = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject<IteratorResult<never>>(readError),
        return: returnIterator,
      }),
    };
    const destination = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => boolean;
      end: ReturnType<typeof vi.fn<() => void>>;
      destroy: (error?: Error) => void;
      destroyed: boolean;
    };
    destination.write = vi.fn().mockReturnValue(true);
    destination.end = vi.fn();
    destination.destroy = vi.fn();
    destination.destroyed = false;
    const controller = new AbortController();
    let failure: StreamCleanupIncompleteError | undefined;
    try {
      const writing = writeSseFrames(
        frames,
        destination,
        controller,
        { recordFirstEligibleFrame: vi.fn() },
        'live_wakeup',
        25,
      );
      const observed = writing.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(25);
      const result = await observed;
      expect(result).toBeInstanceOf(StreamCleanupIncompleteError);
      failure = result as StreamCleanupIncompleteError;
      expect(failure.errors[0]).toBe(readError);
      expect(failure.errors[1]).toMatchObject({
        message: 'Workflow event stream cleanup exceeded 25ms',
      });
      expect(controller.signal.aborted).toBe(true);
      expect(returnIterator).toHaveBeenCalledOnce();
      expect(destination.end).toHaveBeenCalledOnce();

      heldReturn.resolve({ done: true, value: undefined });
      await failure.completion;
      await expect(failure.outcome).resolves.toBeUndefined();
    } finally {
      heldReturn.resolve({ done: true, value: undefined });
      await failure?.completion;
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it.each([
    { failureSource: 'read failure', lateOutcome: 'fulfilled' },
    { failureSource: 'read failure', lateOutcome: 'rejected' },
    { failureSource: 'public projection failure', lateOutcome: 'fulfilled' },
    { failureSource: 'public projection failure', lateOutcome: 'rejected' },
  ] as const)(
    'closes the actual nested stream after $failureSource and observes late $lateOutcome cleanup',
    async ({ failureSource, lateOutcome }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
      const readError = new Error('persisted event read failed');
      const returnError = new Error('live iterator cleanup failed');
      const heldReturn = Promise.withResolvers<IteratorResult<never>>();
      let returnSettled = false;
      void heldReturn.promise.then(
        () => {
          returnSettled = true;
        },
        () => {
          returnSettled = true;
        },
      );
      const returnIterator = vi.fn(() => heldReturn.promise);
      const closeSubscription = vi.fn().mockResolvedValue(undefined);
      const controller = new AbortController();
      const abortStream = vi.fn((reason?: unknown) => {
        controller.abort(reason);
      });
      const drainState = new ApiDrainState();
      const releaseDrainRegistration = drainState.registerStream(controller);
      const destination = new EventEmitter() as EventEmitter & {
        write: ReturnType<typeof vi.fn<(chunk: string) => boolean>>;
        end: ReturnType<typeof vi.fn<() => void>>;
        destroy: ReturnType<typeof vi.fn<(error?: Error) => void>>;
        destroyed: boolean;
      };
      destination.write = vi
        .fn<(chunk: string) => boolean>()
        .mockReturnValue(true);
      destination.end = vi.fn<() => void>();
      destination.destroy = vi.fn<(error?: Error) => void>();
      destination.destroyed = false;

      let observed: Promise<unknown> | undefined;
      let failure: StreamCleanupIncompleteError | undefined;
      try {
        const frames = await new StreamRunEventsUseCase(
          { get: vi.fn().mockResolvedValue({ run: {}, nodes: [] }) },
          {
            findAccess: vi.fn().mockResolvedValue({
              actorId,
              workspaceId,
              role: 'viewer',
              membershipStatus: 'active',
              workspaceStatus: 'active',
            }),
          },
          createWorkflowRunEventStreamer(
            {
              readPage:
                failureSource === 'read failure'
                  ? vi.fn().mockRejectedValue(readError)
                  : vi.fn().mockResolvedValue([
                      {
                        sequence: 1,
                        type: 'run.started',
                        createdAt: '2026-08-21T12:00:00.000Z',
                        payload: { schemaVersion: 2 },
                      },
                    ]),
            },
            {
              subscribe: vi.fn().mockResolvedValue({
                close: closeSubscription,
                [Symbol.asyncIterator]: () => ({
                  next: () =>
                    new Promise<IteratorResult<never>>(() => undefined),
                  return: returnIterator,
                }),
              }),
            },
          ),
        ).execute({
          actor: createActorContext({
            actorId,
            workspaceId,
            sessionId,
            requestId: 'nested-read-cleanup',
          }),
          routeWorkspaceId: workspaceId,
          runId,
          lastEventId: 0,
          sessionExpiresAt: new Date(Date.now() + 60_000),
          reauthorizeSession: vi.fn().mockResolvedValue({
            userId: actorId,
            sessionId,
            expiresAt: new Date(Date.now() + 60_000),
          }),
          abortStream,
          signal: controller.signal,
        });
        const writing = writeSseFrames(
          frames,
          destination,
          controller,
          { recordFirstEligibleFrame: vi.fn() },
          'initial_backfill',
          25,
        );
        observed = writing.catch((error: unknown) => {
          const completion = streamCleanupCompletion(error);
          if (completion === undefined) releaseDrainRegistration();
          else void completion.then(releaseDrainRegistration);
          return error;
        });
        let result: unknown;
        void observed.then((value) => {
          result = value;
        });

        await vi.advanceTimersByTimeAsync(25);
        expect(result).toBeInstanceOf(StreamCleanupIncompleteError);
        failure = result as StreamCleanupIncompleteError;
        const producerError: unknown = failure.errors[0];
        if (failureSource === 'read failure')
          expect(producerError).toBe(readError);
        else expect(producerError).toBeInstanceOf(ZodError);
        expect(failure.errors.at(-1)).toMatchObject({
          message: 'Workflow event stream cleanup exceeded 25ms',
        });
        expect(destination.end).toHaveBeenCalledOnce();
        expect(returnIterator).toHaveBeenCalledOnce();
        expect(closeSubscription).toHaveBeenCalledOnce();
        expect(abortStream).toHaveBeenCalledOnce();
        expect(returnSettled).toBe(false);
        expect(drainState.activeStreamCount()).toBe(1);

        if (lateOutcome === 'fulfilled')
          heldReturn.resolve({ done: true, value: undefined });
        else heldReturn.reject(returnError);
        await failure.completion;
        expect(returnSettled).toBe(true);
        await vi.waitFor(() => {
          expect(drainState.activeStreamCount()).toBe(0);
        });
        if (
          lateOutcome === 'fulfilled' ||
          failureSource === 'public projection failure'
        )
          await expect(failure.outcome).resolves.toBeUndefined();
        else
          await expect(failure.outcome).rejects.toSatisfy(
            (lateFailure: unknown) => {
              expect(nestedAggregateErrors(lateFailure)).toContain(
                producerError,
              );
              expect(nestedAggregateErrors(lateFailure)).toContain(returnError);
              return true;
            },
          );
        expect(returnIterator).toHaveBeenCalledOnce();
        expect(closeSubscription).toHaveBeenCalledOnce();
        expect(abortStream).toHaveBeenCalledOnce();
        expect(destination.end).toHaveBeenCalledOnce();
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        expect(destination.listenerCount('drain')).toBe(0);
        expect(destination.listenerCount('close')).toBe(0);
        expect(destination.listenerCount('error')).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        if (lateOutcome === 'fulfilled')
          heldReturn.resolve({ done: true, value: undefined });
        else heldReturn.reject(returnError);
        await failure?.completion;
        await vi.runAllTimersAsync();
        await observed;
        releaseDrainRegistration();
        vi.useRealTimers();
      }
    },
  );

  it('starts the transport cleanup budget when authorization cleanup is noncooperative', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
    const controller = new AbortController();
    const heldReturn = Promise.withResolvers<IteratorResult<never>>();
    const producerReturn = vi.fn(() => heldReturn.promise);
    const destination = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn<(chunk: string) => boolean>>;
      end: ReturnType<typeof vi.fn<() => void>>;
      destroy: ReturnType<typeof vi.fn<(error?: Error) => void>>;
      destroyed: boolean;
    };
    destination.write = vi
      .fn<(chunk: string) => boolean>()
      .mockReturnValue(true);
    destination.end = vi.fn<() => void>();
    destination.destroy = vi.fn<(error?: Error) => void>();
    destination.destroyed = false;
    let observed: Promise<unknown> | undefined;
    try {
      const frames = await new StreamRunEventsUseCase(
        {
          get: vi.fn().mockResolvedValue({ run: {}, nodes: [] }),
        },
        {
          findAccess: vi.fn().mockResolvedValue({
            actorId,
            workspaceId,
            role: 'viewer',
            membershipStatus: 'active',
            workspaceStatus: 'active',
          }),
        },
        {
          stream: () => ({
            [Symbol.asyncIterator]: () => ({
              next: () => new Promise<IteratorResult<never>>(() => undefined),
              return: producerReturn,
            }),
          }),
        },
      ).execute({
        actor: createActorContext({
          actorId,
          workspaceId,
          sessionId,
          requestId: 'nested-cleanup-budget',
        }),
        routeWorkspaceId: workspaceId,
        runId,
        lastEventId: 0,
        sessionExpiresAt: new Date(Date.now() + 5_000),
        reauthorizeSession: vi
          .fn()
          .mockRejectedValue(new Error('session expired')),
        abortStream: (reason?: unknown) => {
          controller.abort(reason);
        },
        signal: controller.signal,
      });
      observed = writeSseFrames(
        frames,
        destination,
        controller,
        { recordFirstEligibleFrame: vi.fn() },
        'live_wakeup',
        25,
      ).catch((error: unknown) => error);
      let settled: unknown;
      void observed.then((value) => {
        settled = value;
      });

      await vi.advanceTimersByTimeAsync(5_025);

      expect(settled).toBeInstanceOf(StreamCleanupIncompleteError);
      expect(producerReturn).toHaveBeenCalledOnce();
      expect(destination.end).toHaveBeenCalledOnce();
    } finally {
      heldReturn.resolve({ done: true, value: undefined });
      await vi.runAllTimersAsync();
      await observed;
      vi.useRealTimers();
    }
  });

  it('preserves authorization loss with producer cleanup failure', async () => {
    vi.useFakeTimers();
    const authorizationError = new Error('session expired');
    const returnError = new Error('producer cleanup failed');
    const returned = vi.fn().mockRejectedValue(returnError);
    try {
      const frames = await new StreamRunEventsUseCase(
        {
          get: vi.fn().mockResolvedValue({ run: {}, nodes: [] }),
        },
        {
          findAccess: vi.fn().mockResolvedValue({
            actorId,
            workspaceId,
            role: 'viewer',
            membershipStatus: 'active',
            workspaceStatus: 'active',
          }),
        },
        {
          stream: () => ({
            [Symbol.asyncIterator]: () => ({
              next: () => new Promise<IteratorResult<never>>(() => undefined),
              return: returned,
            }),
          }),
        },
      ).execute({
        actor: createActorContext({
          actorId,
          workspaceId,
          sessionId,
          requestId: 'request-42',
        }),
        routeWorkspaceId: workspaceId,
        runId,
        lastEventId: 0,
        sessionExpiresAt: new Date(Date.now() + 5_000),
        reauthorizeSession: vi.fn().mockRejectedValue(authorizationError),
        abortStream: vi.fn(),
        signal: new AbortController().signal,
      });
      const reading = frames[Symbol.asyncIterator]().next();
      const outcome = reading.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(5_000);
      const failure = await outcome;

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        authorizationError,
        returnError,
      ]);
      expect(returned).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('revokes authorization while a frame is blocked on transport backpressure', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let producerCleanedUp = false;
    let producerSignal: AbortSignal | undefined;
    let reauthorizationSignal: AbortSignal | undefined;
    const expiresAt = new Date(Date.now() + 5_000);
    const stalledLookup = Promise.withResolvers<{
      userId: string;
      sessionId: string;
      expiresAt: Date;
    }>();
    const authorizedSession = {
      userId: actorId,
      sessionId,
      expiresAt,
    };
    const reauthorizeSession = vi
      .fn()
      .mockResolvedValueOnce(authorizedSession)
      .mockImplementation((signal: AbortSignal) => {
        reauthorizationSignal = signal;
        return stalledLookup.promise;
      });
    const access = {
      findAccess: vi.fn().mockResolvedValue({
        actorId,
        workspaceId,
        role: 'viewer' as const,
        membershipStatus: 'active' as const,
        workspaceStatus: 'active' as const,
      }),
    };
    const useCase = new StreamRunEventsUseCase(
      {
        get: vi.fn().mockResolvedValue({ run: {}, nodes: [] }),
      },
      access,
      {
        stream: ({ signal }) => {
          producerSignal = signal;
          return {
            async *[Symbol.asyncIterator]() {
              try {
                await Promise.resolve();
                yield frame(1);
                yield frame(2);
              } finally {
                producerCleanedUp = true;
              }
            },
          };
        },
      },
    );
    const streamInput = {
      actor: createActorContext({
        actorId,
        workspaceId,
        sessionId,
        requestId: 'request-42',
      }),
      routeWorkspaceId: workspaceId,
      runId,
      lastEventId: 0,
      sessionExpiresAt: expiresAt,
      reauthorizeSession,
      signal: controller.signal,
      abortStream: (reason?: unknown) => {
        controller.abort(reason);
      },
    };
    const destination = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn<(chunk: string) => boolean>>;
      end: ReturnType<typeof vi.fn<() => void>>;
      destroy: ReturnType<typeof vi.fn<(error?: Error) => void>>;
      destroyed: boolean;
    };
    destination.write = vi
      .fn<(chunk: string) => boolean>()
      .mockReturnValue(false);
    destination.end = vi.fn<() => void>();
    destination.destroy = vi.fn<(error?: Error) => void>();
    destination.destroyed = false;

    let writing: Promise<void> | undefined;
    try {
      const frames = await useCase.execute(streamInput);
      writing = writeSseFrames(
        frames,
        destination,
        controller,
        { recordFirstEligibleFrame: vi.fn() },
        'live_wakeup',
      );
      await vi.waitFor(() => {
        expect(destination.listenerCount('drain')).toBe(1);
      });

      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();

      expect(controller.signal.aborted).toBe(true);
      const cleanup = Promise.race([
        writing.then(() => 'settled' as const),
        new Promise<'timed_out'>((resolve) => {
          setTimeout(() => {
            resolve('timed_out');
          }, 1);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await cleanup).toBe('settled');
      expect(destination.write).toHaveBeenCalledOnce();
      expect(reauthorizeSession).toHaveBeenCalledTimes(2);
      expect(reauthorizationSignal?.aborted).toBe(true);
      expect(producerSignal?.aborted).toBe(true);
      expect(producerCleanedUp).toBe(true);
      expect(destination.listenerCount('drain')).toBe(0);
      expect(destination.listenerCount('close')).toBe(0);
      expect(destination.listenerCount('error')).toBe(0);
      expect(destination.end).toHaveBeenCalledOnce();
    } finally {
      stalledLookup.resolve(authorizedSession);
      if (!controller.signal.aborted) controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      await writing;
      vi.useRealTimers();
    }
  });
});
