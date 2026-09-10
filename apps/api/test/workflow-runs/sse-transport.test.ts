import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createActorContext } from '../../src/workspaces/index.js';
import { writeSseFrames } from '../../src/workflow-runs/controllers.js';
import {
  createStreamAuthorizationLifetime,
  nextFrameOrAuthorizationLoss,
} from '../../src/workflow-runs/sse-authorization-lifetime.js';
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

describe('workflow run SSE transport', () => {
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
