import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';

import { createActorContext } from '../../../../src/authorization/index.js';

import { writeSseFrames } from '../../../../src/workflow-runs/events/sse-transport.js';

import { StreamCleanupIncompleteError } from '../../../../src/workflow-runs/events/stream-cleanup.js';
import { StreamRunEventsUseCase } from '../../../../src/workflow-runs/use-cases.js';
import { actorId, sessionId, workspaceId, runId } from './fixture.js';

export function registerStartsTransportCleanupBudgetAuthorizationCleanup(): void {
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
          canRead: () => Promise.resolve(true),
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
      observed = writeSseFrames(frames, destination, {
        controller: controller,
        visibilityMetrics: { recordFirstEligibleFrame: vi.fn() },
        fallbackPath: 'live_wakeup',
        cleanupBudgetMs: 25,
      }).catch((error: unknown) => error);
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
          canRead: () => Promise.resolve(true),
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
}
