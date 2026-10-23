import { expect, it, vi } from 'vitest';

import { StreamRunEventsUseCase } from '../../../src/workflow-runs/use-cases.js';

import {
  actorId,
  sessionId,
  workspaceId,
  runId,
  actor,
  authorization,
  persistence,
} from './fixture.js';

export function registerStopsBeforeLaterFrameAfterS(): void {
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
}
