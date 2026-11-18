import { describe, expect, it, vi } from 'vitest';
import {
  workspaceId,
  runId,
  request,
  sseReply,
  streamController,
} from './controllers.fixture.js';
import { ApiDrainState } from '../../../src/platform/health/drain-state.js';
import type { workflowRunRoutes as routes } from '@pertexo/contracts/server';
import { routeInput } from '../../support/route-input.js';
import { workspaceCallerFor } from '../../workspaces/request/caller.fixture.js';

const events = (lastEventId?: string) =>
  routeInput<typeof routes.events>({
    params: { workspaceId, runId },
    headers: lastEventId === undefined ? {} : { 'last-event-id': lastEventId },
  });

/**
 * What the run routes record and answer runs over real HTTP in
 * http/run-commands.integration.test.ts, workspaces/real-api.integration.test.ts
 * (stream access lost on a role change) and events/missing-hint.integration.test.ts
 * (wire frames and Last-Event-ID). These cases stay because only a held
 * response shows the cleanup budget and a throwing metrics sink or producer.
 */
describe('workflow runs controller', () => {
  it('records visibility only after the first successful emission for a sequence', async () => {
    const visibilityMetrics = { recordFirstEligibleFrame: vi.fn() };
    const stream = {
      execute: vi.fn().mockResolvedValue({
        *[Symbol.asyncIterator]() {
          const frame = {
            id: 2,
            event: 'run.started',
            data: JSON.stringify({
              sequence: 2,
              type: 'run.started',
              createdAt: '2026-08-21T12:00:00.000Z',
              payload: {},
            }),
            visibilityPath: 'live_wakeup' as const,
          };
          yield frame;
          yield frame;
        },
      }),
    };
    const instance = streamController(stream, visibilityMetrics);

    const reply = sseReply();
    await instance.streamRunEvents(
      request(),
      workspaceCallerFor(request(), workspaceId),
      events(),
      reply as never,
    );

    expect(reply.raw.chunks).toHaveLength(2);
    expect(visibilityMetrics.recordFirstEligibleFrame).toHaveBeenCalledTimes(1);
    expect(visibilityMetrics.recordFirstEligibleFrame).toHaveBeenCalledWith({
      createdAt: new Date('2026-08-21T12:00:00.000Z'),
      path: 'live_wakeup',
    });
  });

  it('delivers every frame and cleans the producer when visibility metrics throw', async () => {
    const metricFailure = new Error('visibility recorder failed');
    const visibilityMetrics = {
      recordFirstEligibleFrame: vi.fn(() => {
        throw metricFailure;
      }),
    };
    const returned = vi.fn();
    const stream = {
      execute: vi.fn().mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          try {
            await Promise.resolve();
            for (const sequence of [1, 2]) {
              yield {
                id: sequence,
                event: 'run.started',
                data: JSON.stringify({
                  sequence,
                  type: 'run.started',
                  createdAt: '2026-08-21T12:00:00.000Z',
                  payload: {},
                }),
                visibilityPath: 'live_wakeup' as const,
              };
            }
          } finally {
            returned();
          }
        },
      }),
    };
    const instance = streamController(stream, visibilityMetrics);
    const reply = sseReply();

    await instance.streamRunEvents(
      request(),
      workspaceCallerFor(request(), workspaceId),
      events(),
      reply as never,
    );

    expect(reply.raw.chunks).toHaveLength(2);
    expect(visibilityMetrics.recordFirstEligibleFrame).toHaveBeenCalledTimes(2);
    expect(returned).toHaveBeenCalledOnce();
    const end = vi.mocked(reply.raw.end);
    expect(end).toHaveBeenCalledOnce();
  });

  it('ends a committed response on the cleanup budget but retains drain ownership until late cleanup settles', async () => {
    vi.useFakeTimers();
    const drainState = new ApiDrainState();
    const heldReturn = Promise.withResolvers<IteratorResult<never>>();
    const returnIterator = vi.fn(() => heldReturn.promise);
    const stream = {
      execute: vi.fn().mockResolvedValue({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            Promise.reject<IteratorResult<never>>(
              new Error('producer read failed'),
            ),
          return: returnIterator,
        }),
      }),
    };
    const instance = streamController(
      stream,
      { recordFirstEligibleFrame: vi.fn() },
      drainState,
    );
    const reply = sseReply();
    let streaming: Promise<void> | undefined;
    try {
      streaming = instance.streamRunEvents(
        request(),
        workspaceCallerFor(request(), workspaceId),
        events(),
        reply as never,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(drainState.activeStreamCount()).toBe(1);
      expect(returnIterator).toHaveBeenCalledOnce();
      const end = vi.mocked(reply.raw.end);
      expect(end).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(streaming).resolves.toBeUndefined();
      expect(reply.raw.destroyed).toBe(true);
      expect(drainState.activeStreamCount()).toBe(1);

      heldReturn.resolve({ done: true, value: undefined });
      await vi.waitFor(() => {
        expect(drainState.activeStreamCount()).toBe(0);
      });
    } finally {
      heldReturn.resolve({ done: true, value: undefined });
      await vi.runAllTimersAsync();
      await streaming;
      vi.useRealTimers();
    }
  });

  it('releases request and drain ownership when SSE response preparation fails before producer acquisition', async () => {
    const preparationFailure = new Error('flush headers failed');
    const iteratorFactory = vi.fn();
    const stream = {
      execute: vi.fn().mockResolvedValue({
        [Symbol.asyncIterator]: iteratorFactory,
      }),
    };
    const drainState = new ApiDrainState();
    const instance = streamController(
      stream,
      { recordFirstEligibleFrame: vi.fn() },
      drainState,
    );
    const selectedRequest = request();
    const removeCloseListener = vi.spyOn(selectedRequest.raw, 'off');
    const reply = sseReply();
    reply.raw.flushHeaders = vi.fn(() => {
      throw preparationFailure;
    });

    await expect(
      instance.streamRunEvents(
        selectedRequest,
        workspaceCallerFor(selectedRequest, workspaceId),
        events(),
        reply as never,
      ),
    ).rejects.toBe(preparationFailure);

    expect(iteratorFactory).not.toHaveBeenCalled();
    expect(removeCloseListener).toHaveBeenCalledOnce();
    expect(drainState.activeStreamCount()).toBe(0);
  });

  it('ends and destroys a committed response when the producer iterator factory throws', async () => {
    const iteratorFailure = new Error('producer iterator failed');
    const stream = {
      execute: vi.fn().mockResolvedValue({
        [Symbol.asyncIterator]: () => {
          throw iteratorFailure;
        },
      }),
    };
    const drainState = new ApiDrainState();
    const instance = streamController(
      stream,
      { recordFirstEligibleFrame: vi.fn() },
      drainState,
    );
    const selectedRequest = request();
    const removeCloseListener = vi.spyOn(selectedRequest.raw, 'off');
    const reply = sseReply();

    await expect(
      instance.streamRunEvents(
        selectedRequest,
        workspaceCallerFor(selectedRequest, workspaceId),
        events(),
        reply as never,
      ),
    ).resolves.toBeUndefined();

    const end = vi.mocked(reply.raw.end);
    expect(end).toHaveBeenCalledOnce();
    expect(reply.raw.destroyed).toBe(true);
    expect(removeCloseListener).toHaveBeenCalledOnce();
    expect(drainState.activeStreamCount()).toBe(0);
  });
});
