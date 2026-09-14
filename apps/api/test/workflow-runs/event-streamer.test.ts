import { describe, expect, it, vi } from 'vitest';

import type { PersistedRunEvent } from '../../src/executions/run-event-stream.js';
import { createWorkflowRunEventStreamer } from '../../src/workflow-runs/event-streamer.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const nodeRunId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const attemptId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const artifactId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function controlledStream(event: PersistedRunEvent) {
  const order: string[] = [];
  const close = vi.fn().mockResolvedValue(undefined);
  const returnIterator = vi.fn().mockResolvedValue({
    done: true as const,
    value: undefined,
  });
  const subscription = {
    close,
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<never>(() => undefined),
      return: returnIterator,
    }),
  };
  const liveSource = {
    subscribe: async () => {
      await Promise.resolve();
      order.push('subscribe');
      return subscription;
    },
  };
  let reads = 0;
  const reader = {
    readPage: async () => {
      await Promise.resolve();
      order.push('read');
      reads += 1;
      return reads === 1 ? [event] : [];
    },
  };
  const controller = new AbortController();
  const frames = createWorkflowRunEventStreamer(reader, liveSource).stream({
    workspaceId,
    runId,
    lastEventId: 0,
    signal: controller.signal,
  });
  const iterator = frames[Symbol.asyncIterator]();
  return { close, controller, iterator, order, returnIterator };
}

function persistedEvent(
  payload: unknown,
  overrides: Partial<PersistedRunEvent> = {},
): PersistedRunEvent {
  return {
    sequence: 1,
    type: 'node.succeeded',
    createdAt: '2026-08-21T12:00:00.000Z',
    payload,
    ...overrides,
  };
}

describe('public workflow run event streamer', () => {
  it('subscribes first, projects every public field, and strips secret and unknown data', async () => {
    const payload = {
      schemaVersion: 1,
      invocationKey: 'root/http/1',
      nodeId: 'http_1',
      nodeRunId,
      attemptId,
      attemptNumber: 2,
      dueAt: '2026-08-21T12:01:00.000Z',
      safeErrorCode: 'provider.timeout',
      reasonCode: 'operator_canceled',
      outputRef: { kind: 'artifact', artifactId },
      actor: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      operatorNote: 'secret operator note',
      futureInternalField: { secret: true },
    };
    const stream = controlledStream(persistedEvent(payload));

    const frame = await stream.iterator.next();
    stream.controller.abort();
    await stream.iterator.return?.();

    expect(stream.order.slice(0, 2)).toEqual(['subscribe', 'read']);
    expect(frame).toEqual({
      done: false,
      value: {
        id: 1,
        event: 'node.succeeded',
        visibilityPath: 'initial_backfill',
        data: JSON.stringify({
          sequence: 1,
          type: 'node.succeeded',
          createdAt: '2026-08-21T12:00:00.000Z',
          payload: {
            schemaVersion: 1,
            invocationKey: 'root/http/1',
            nodeId: 'http_1',
            nodeRunId,
            attemptId,
            attemptNumber: 2,
            dueAt: '2026-08-21T12:01:00.000Z',
            safeErrorCode: 'provider.timeout',
            reasonCode: 'operator_canceled',
            outputRef: { kind: 'artifact', artifactId },
          },
        }),
      },
    });
    expect(JSON.stringify(frame)).not.toContain('secret operator note');
    expect(JSON.stringify(frame)).not.toContain('futureInternalField');
    expect(stream.close).toHaveBeenCalledOnce();
    expect(stream.returnIterator).toHaveBeenCalledOnce();
  });

  it.each([
    ['schema version', { schemaVersion: 2 }],
    ['empty invocation key', { schemaVersion: 1, invocationKey: '' }],
    ['invalid node run id', { schemaVersion: 1, nodeRunId: 'invalid' }],
    ['negative attempt number', { schemaVersion: 1, attemptNumber: -1 }],
    ['invalid due time', { schemaVersion: 1, dueAt: 'tomorrow' }],
    ['empty safe error code', { schemaVersion: 1, safeErrorCode: '' }],
    [
      'invalid output reference',
      {
        schemaVersion: 1,
        outputRef: { kind: 'artifact', artifactId: 'invalid' },
      },
    ],
  ] as const)(
    'rejects malformed public %s and releases the stream',
    async (_label, payload) => {
      const stream = controlledStream(persistedEvent(payload));

      await expect(stream.iterator.next()).rejects.toBeDefined();

      expect(stream.close).toHaveBeenCalledOnce();
      expect(stream.returnIterator).toHaveBeenCalledOnce();
    },
  );

  it('rejects an unknown persisted event type before emitting it and releases the stream', async () => {
    const stream = controlledStream(
      persistedEvent({ schemaVersion: 1 }, { type: 'run.future_internal' }),
    );

    await expect(stream.iterator.next()).rejects.toBeDefined();

    expect(stream.close).toHaveBeenCalledOnce();
    expect(stream.returnIterator).toHaveBeenCalledOnce();
  });
});
