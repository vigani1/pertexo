import { firstValueFrom, take } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowRunsController } from '../../src/workflow-runs/controllers.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
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
      get as never,
      stream as never,
      cancel as never,
    ),
    start,
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
