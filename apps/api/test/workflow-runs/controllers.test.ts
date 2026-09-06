import { firstValueFrom, take } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowRunsController } from '../../src/workflow-runs/controllers.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
    const observable = await fixture.instance.streamRunEvents(
      request({ 'last-event-id': '1' }),
      { workspaceId, runId },
    );
    const message = await firstValueFrom(observable.pipe(take(1)));

    expect(fixture.stream.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        routeWorkspaceId: workspaceId,
        runId,
        lastEventId: 1,
      }),
    );
    expect(message).toEqual({
      id: '2',
      type: 'run.started',
      data: {
        sequence: 2,
        type: 'run.started',
        createdAt: '2026-08-21T12:00:00.000Z',
        payload: { schemaVersion: 1 },
      },
    });
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

    const observable = await instance.streamRunEvents(request(), {
      workspaceId,
      runId,
    });
    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const subscription = observable.subscribe({
        next: (value) => messages.push(value),
        error: reject,
        complete: resolve,
      });
      void subscription;
    });

    expect(messages).toHaveLength(2);
    expect(visibilityMetrics.recordFirstEligibleFrame).toHaveBeenCalledTimes(1);
    expect(visibilityMetrics.recordFirstEligibleFrame).toHaveBeenCalledWith({
      createdAt: new Date('2026-08-21T12:00:00.000Z'),
      path: 'live_wakeup',
    });
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
