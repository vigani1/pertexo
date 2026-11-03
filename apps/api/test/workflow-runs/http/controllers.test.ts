import { describe, expect, it, vi } from 'vitest';
import {
  actorId,
  guardActorId,
  sessionId,
  workspaceId,
  workflowId,
  runId,
  request,
  sseReply,
  controller,
  workflowVersionId,
  streamController,
} from './controllers/fixture.js';
import { ApiDrainState } from '../../../src/platform/health/drain-state.js';

describe('workflow runs controller public seam', () => {
  it('strictly parses and forwards bounded run-history filters', async () => {
    const fixture = controller();
    await fixture.instance.listRuns(
      request(),
      { workspaceId },
      {
        limit: '25',
        workflowId,
        status: 'succeeded',
        createdAtFrom: '2026-08-20T00:00:00.000Z',
        createdAtBefore: '2026-08-21T00:00:00.000Z',
      },
    );
    expect(fixture.list.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        routeWorkspaceId: workspaceId,
        limit: 25,
        workflowId,
        status: 'succeeded',
      }),
    );
    await expect(
      fixture.instance.listRuns(request(), { workspaceId }, { unknown: true }),
    ).rejects.toBeDefined();
    expect(fixture.list.execute).toHaveBeenCalledTimes(1);
  });

  it('strictly parses a fixed statistics window and optional breakdown', async () => {
    const fixture = controller();
    await fixture.instance.getRunStatistics(
      request(),
      { workspaceId },
      { window: '7d', breakdown: 'workflow' },
    );
    await fixture.instance.getRunStatistics(
      request(),
      { workspaceId },
      undefined,
    );
    expect(fixture.statistics.execute).toHaveBeenNthCalledWith(1, {
      actor: expect.objectContaining({ actorId, workspaceId }) as unknown,
      routeWorkspaceId: workspaceId,
      window: '7d',
      breakdown: 'workflow',
    });
    expect(fixture.statistics.execute.mock.calls[1]?.[0]).not.toHaveProperty(
      'window',
    );
    for (const query of [
      { window: '30d' },
      { createdAtFrom: '2026-08-20T00:00:00.000Z' },
    ])
      await expect(
        fixture.instance.getRunStatistics(request(), { workspaceId }, query),
      ).rejects.toBeDefined();
    await expect(
      fixture.instance.getRunStatistics(
        request(),
        { workspaceId: 'not-a-workspace' },
        {},
      ),
    ).rejects.toBeDefined();
    expect(fixture.statistics.execute).toHaveBeenCalledTimes(2);
  });

  it('forwards distinct sub-millisecond run-history boundaries', async () => {
    const fixture = controller();
    await fixture.instance.listRuns(
      request(),
      { workspaceId },
      {
        createdAtFrom: '2026-08-21T00:00:00.000100Z',
        createdAtBefore: '2026-08-21T00:00:00.000900Z',
      },
    );

    expect(fixture.list.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAtFrom: '2026-08-21T00:00:00.000100Z',
        createdAtBefore: '2026-08-21T00:00:00.000900Z',
      }),
    );
  });

  it('uses session context without a guard and gives guarded context precedence', async () => {
    const fixture = controller();
    await fixture.instance.startRun(
      request({ 'idempotency-key': 'session-context' }),
      { workspaceId, workflowId },
      {},
    );
    expect(fixture.start.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest asymmetric matcher is intentionally untyped at this nested boundary.
        actor: expect.objectContaining({ actorId, requestId: 'request-42' }),
        requestId: 'request-42',
        traceId: 'trace-42',
      }),
    );
    expect(fixture.start.execute.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      'authorizedWorkspace',
    );

    const authorizedWorkspace = {
      actor: Object.freeze({
        actorId: guardActorId,
        kind: 'user' as const,
        workspaceId,
        sessionId,
        requestId: 'guard-request',
        traceId: 'guard-trace',
      }),
      workspaceId,
      role: 'owner' as const,
      capability: 'run:start' as const,
    };
    await fixture.instance.startRun(
      {
        ...request({ 'idempotency-key': 'guard-context' }),
        authorizedWorkspace,
      },
      { workspaceId, workflowId },
      {},
    );
    expect(fixture.start.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actor: authorizedWorkspace.actor,
        authorizedWorkspace,
        requestId: 'guard-request',
        traceId: 'guard-trace',
      }),
    );
  });

  it('passes controller-owned SSE reauthorization and authorization to the stream use case', async () => {
    const fixture = controller();
    const reply = sseReply();
    const reauthorizeIdentitySession = vi.fn(
      request().reauthorizeIdentitySession,
    );
    const authorizedWorkspace = {
      actor: Object.freeze({
        actorId: guardActorId,
        kind: 'user' as const,
        workspaceId,
        sessionId,
        requestId: 'guard-request',
      }),
      workspaceId,
      role: 'viewer' as const,
      capability: 'run:read' as const,
    };
    await fixture.instance.streamRunEvents(
      {
        ...request(),
        authorizedWorkspace,
        reauthorizeIdentitySession,
      },
      { workspaceId, runId },
      reply as never,
    );
    expect(fixture.stream.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: authorizedWorkspace.actor,
        authorizedWorkspace,
        reauthorizeSession: reauthorizeIdentitySession,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest asymmetric matcher is intentionally untyped at this nested boundary.
        abortStream: expect.any(Function),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest asymmetric matcher is intentionally untyped at this nested boundary.
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('parses one start request and forwards idempotency and trace context', async () => {
    const fixture = controller();
    await fixture.instance.startRun(
      request({
        'idempotency-key': 'run-start-42',
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      }),
      { workspaceId, workflowId },
      { input: { customerId: 'customer-42' } },
    );

    expect(fixture.start.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        routeWorkspaceId: workspaceId,
        workflowId,
        idempotencyKey: 'run-start-42',
        input: { customerId: 'customer-42' },
        requestId: 'request-42',
        traceId: 'trace-42',
      }),
    );
  });

  it('rejects a missing idempotency key before calling the start use case', async () => {
    const fixture = controller();
    await expect(
      fixture.instance.startRun(request(), { workspaceId, workflowId }, {}),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    expect(fixture.start.execute).not.toHaveBeenCalled();
  });

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
        { workspaceId, runId },
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
        { workspaceId, runId },
        reply as never,
      ),
    ).resolves.toBeUndefined();

    const end = vi.mocked(reply.raw.end);
    expect(end).toHaveBeenCalledOnce();
    expect(reply.raw.destroyed).toBe(true);
    expect(removeCloseListener).toHaveBeenCalledOnce();
    expect(drainState.activeStreamCount()).toBe(0);
  });

  it('forwards durable cancellation actor, reason, and trace context', async () => {
    const fixture = controller();
    await fixture.instance.cancelRun(
      request({
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      }),
      { workspaceId, runId },
      { reason: 'operator request' },
    );

    expect(fixture.cancel.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        routeWorkspaceId: workspaceId,
        runId,
        reason: 'operator request',
        requestId: 'request-42',
        traceId: 'trace-42',
      }),
    );
  });
});
