import { expect, it, vi } from 'vitest';

import { ApiDrainState } from '../../../../src/platform/health/drain-state.js';

import {
  workspaceId,
  workflowVersionId,
  runId,
  request,
  sseReply,
  controller,
  streamController,
} from './fixture.js';

export function registerParsesExplicitReplayRequestForwardsSource(): void {
  it('parses an explicit replay request and forwards the source and version', async () => {
    const fixture = controller();
    await fixture.instance.replayRun(
      request({
        'idempotency-key': 'run-replay-42',
        'x-csrf-token': 'csrf-token-42',
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      }),
      { workspaceId, runId },
      {
        workflowVersionId,
        input: { customerId: 'customer-42' },
        deadlineAt: '2026-08-21T18:00:00.000Z',
      },
    );

    expect(fixture.replay.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        routeWorkspaceId: workspaceId,
        runId,
        workflowVersionId,
        input: { customerId: 'customer-42' },
        deadlineAt: '2026-08-21T18:00:00.000Z',
        idempotencyKey: 'run-replay-42',
        requestId: 'request-42',
        traceId: 'trace-42',
      }),
    );
  });

  it('parses Last-Event-ID and exposes each persisted event as an SSE message', async () => {
    const fixture = controller();
    const reply = sseReply();
    await fixture.instance.streamRunEvents(
      request({ 'last-event-id': '1' }),
      { workspaceId, runId },
      reply as never,
    );

    expect(fixture.stream.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        routeWorkspaceId: workspaceId,
        runId,
        lastEventId: 1,
      }),
    );
    expect(reply.raw.chunks).toEqual([
      'id: 2\nevent: run.started\ndata: {"sequence":2,"type":"run.started","createdAt":"2026-08-21T12:00:00.000Z","payload":{}}\n\n',
    ]);
  });

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
      { workspaceId, runId },
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
      { workspaceId, runId },
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
        { workspaceId, runId },
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
}
