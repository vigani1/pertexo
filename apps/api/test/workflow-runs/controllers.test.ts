import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { WorkflowRunsController } from '../../src/workflow-runs/controllers.js';
import { APPLICATION_ERROR_CATALOG } from '../../src/platform/http/index.js';
import { ApiDrainState } from '../../src/platform/health/drain-state.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const guardActorId = '99999999-9999-4999-8999-999999999999';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const workflowVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function request(headers: Record<string, string> = {}) {
  const closeListeners = new Set<() => void>();
  return {
    requestId: 'request-42',
    traceId: 'trace-42',
    headers,
    identitySession: {
      userId: actorId,
      sessionId,
      expiresAt: new Date('2026-08-21T20:00:00.000Z'),
      clientMetadata: {},
    },
    reauthorizeIdentitySession: () =>
      Promise.resolve({
        userId: actorId,
        sessionId,
        expiresAt: new Date('2026-08-21T20:00:00.000Z'),
        clientMetadata: {},
      }),
    raw: {
      once: (_event: 'close', listener: () => void) => {
        closeListeners.add(listener);
      },
      off: (_event: 'close', listener: () => void) => {
        closeListeners.delete(listener);
      },
    },
  } as const;
}

function sseReply() {
  const raw = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headersSent: boolean;
    destroyed: boolean;
    chunks: string[];
    setHeader: (name: string, value: string) => void;
    flushHeaders: () => void;
    write: (chunk: string) => boolean;
    end: () => void;
    destroy: () => void;
  };
  raw.statusCode = 0;
  raw.headersSent = false;
  raw.destroyed = false;
  raw.chunks = [];
  raw.setHeader = vi.fn();
  raw.flushHeaders = () => {
    raw.headersSent = true;
  };
  raw.write = (chunk) => {
    raw.chunks.push(chunk);
    return true;
  };
  raw.end = vi.fn();
  raw.destroy = () => {
    raw.destroyed = true;
  };
  return { raw, hijack: vi.fn() };
}

function controller() {
  const start = {
    execute: vi.fn().mockResolvedValue({ run: {}, replayed: false }),
  };
  const replay = {
    execute: vi.fn().mockResolvedValue({ run: {}, replayed: false }),
  };
  const get = { execute: vi.fn().mockResolvedValue({ run: {}, nodes: [] }) };
  const cancel = {
    execute: vi.fn().mockResolvedValue({ run: {}, alreadyRequested: false }),
  };
  const stream = {
    execute: vi.fn().mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield {
          id: 2,
          event: 'run.started',
          data: JSON.stringify({
            sequence: 2,
            type: 'run.started',
            createdAt: '2026-08-21T12:00:00.000Z',
            payload: { schemaVersion: 1 },
          }),
        };
      },
    }),
  };
  return {
    instance: new WorkflowRunsController(
      start as never,
      replay as never,
      get as never,
      stream as never,
      cancel as never,
    ),
    start,
    replay,
    get,
    stream,
    cancel,
  };
}

describe('workflow runs controller public seam', () => {
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

  it('maps an invalid session actor to request.invalid status 400', async () => {
    const fixture = controller();
    const invalid = {
      ...request({ 'idempotency-key': 'invalid-actor' }),
      identitySession: { ...request().identitySession, userId: 'not-a-uuid' },
    };
    await expect(
      fixture.instance.startRun(invalid, { workspaceId, workflowId }, {}),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    expect(APPLICATION_ERROR_CATALOG['request.invalid'].status).toBe(400);
    expect(fixture.start.execute).not.toHaveBeenCalled();
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
    ).rejects.toMatchObject({ code: 'request.precondition_required' });
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
      'id: 2\nevent: run.started\ndata: {"sequence":2,"type":"run.started","createdAt":"2026-08-21T12:00:00.000Z","payload":{"schemaVersion":1}}\n\n',
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
              payload: { schemaVersion: 1 },
            }),
            visibilityPath: 'live_wakeup' as const,
          };
          yield frame;
          yield frame;
        },
      }),
    };
    const instance = new WorkflowRunsController(
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      stream as never,
      { execute: vi.fn() } as never,
      visibilityMetrics,
    );

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
                  payload: { schemaVersion: 1 },
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
    const instance = new WorkflowRunsController(
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      stream as never,
      { execute: vi.fn() } as never,
      visibilityMetrics,
    );
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
    const instance = new WorkflowRunsController(
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      stream as never,
      { execute: vi.fn() } as never,
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
    const instance = new WorkflowRunsController(
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      stream as never,
      { execute: vi.fn() } as never,
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
    const instance = new WorkflowRunsController(
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
      stream as never,
      { execute: vi.fn() } as never,
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
