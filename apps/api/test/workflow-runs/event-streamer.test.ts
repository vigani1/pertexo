import { describe, expect, it } from 'vitest';

import { createWorkflowRunEventStreamer } from '../../src/workflow-runs/event-streamer.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('public workflow run event streamer', () => {
  it('subscribes before reading and strips cancellation actor and reason data', async () => {
    const order: string[] = [];
    const subscription = {
      close: async () => Promise.resolve(),
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield { kind: 'resync' as const };
      },
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
        return reads === 1
          ? [
              {
                sequence: 1,
                type: 'run.cancel_requested',
                createdAt: '2026-08-21T12:00:00.000Z',
                payload: {
                  schemaVersion: 1,
                  actor: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                  reason: 'secret operator note',
                },
              },
            ]
          : [];
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

    const frame = await iterator.next();
    controller.abort();
    await iterator.return?.();

    expect(order.slice(0, 2)).toEqual(['subscribe', 'read']);
    const value = frame.value as Readonly<{
      id: number;
      event: string;
      data: string;
    }>;
    expect(value).toEqual({
      id: 1,
      event: 'run.cancel_requested',
      visibilityPath: 'initial_backfill',
      data: JSON.stringify({
        sequence: 1,
        type: 'run.cancel_requested',
        createdAt: '2026-08-21T12:00:00.000Z',
        payload: { schemaVersion: 1 },
      }),
    });
    expect(value.data).not.toContain('secret operator note');
  });
});
