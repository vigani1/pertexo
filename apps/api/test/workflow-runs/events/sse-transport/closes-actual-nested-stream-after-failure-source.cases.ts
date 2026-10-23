import { EventEmitter, getEventListeners } from 'node:events';
import { expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { createWorkflowRunEventStreamer } from '../../../../src/workflow-runs/events/streamer.js';
import { createActorContext } from '../../../../src/authorization/index.js';
import { ApiDrainState } from '../../../../src/platform/health/drain-state.js';
import { writeSseFrames } from '../../../../src/workflow-runs/events/sse-transport.js';

import {
  streamCleanupCompletion,
  StreamCleanupIncompleteError,
} from '../../../../src/workflow-runs/events/stream-cleanup.js';
import { StreamRunEventsUseCase } from '../../../../src/workflow-runs/use-cases.js';
import {
  actorId,
  sessionId,
  workspaceId,
  runId,
  nestedAggregateErrors,
} from './fixture.js';

export function registerClosesActualNestedStreamAfterFailureSource(): void {
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
                        payload: { attemptNumber: -1 },
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
        const writing = writeSseFrames(frames, destination, {
          controller: controller,
          visibilityMetrics: { recordFirstEligibleFrame: vi.fn() },
          fallbackPath: 'initial_backfill',
          cleanupBudgetMs: 25,
        });
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
}
