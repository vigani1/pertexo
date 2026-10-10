import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import {
  RedisWorkspaceInboxHintPublisher,
  WorkspaceInboxHintPublishError,
  encodeWorkspaceInboxHint,
  parseWorkspaceInboxHint,
  workspaceInboxChannel,
} from '../src/pubsub/workspace-inbox.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const otherWorkspaceId = '22222222-2222-4222-8222-222222222222';

function fakeRedis(publish: (channel: string, payload: string) => unknown) {
  const mocks = { publish: vi.fn(publish), disconnect: vi.fn() };
  return {
    mocks,
    redis: { on: vi.fn(), ...mocks } as unknown as Redis,
  };
}

const telemetry = { connectionEvent: vi.fn(), operationFinished: vi.fn() };

describe('workspace inbox hints', () => {
  it('derives an opaque, stable channel per workspace', () => {
    const channel = workspaceInboxChannel(workspaceId);
    expect(channel).toMatch(/^workspace-inbox:[A-Za-z0-9_-]{43}$/u);
    expect(channel).toBe(workspaceInboxChannel(workspaceId));
    expect(channel).not.toBe(workspaceInboxChannel(otherWorkspaceId));
    expect(channel).not.toContain(workspaceId);
    expect(() => workspaceInboxChannel('not-a-workspace')).toThrow();
  });

  it('round-trips a content-free change hint', () => {
    const message = encodeWorkspaceInboxHint('42');
    expect(JSON.parse(message)).toEqual({ kind: 'changed', revision: '42' });
    expect(parseWorkspaceInboxHint(message)).toEqual({
      kind: 'changed',
      revision: '42',
    });
    expect(() => encodeWorkspaceInboxHint('0')).toThrow();
  });

  it.each([
    ['malformed JSON', '{'],
    ['an unknown kind', '{"kind":"resync","revision":"1"}'],
    ['an extra field', '{"kind":"changed","revision":"1","workflowId":"x"}'],
    ['a zero revision', '{"kind":"changed","revision":"0"}'],
    [
      'an oversized message',
      `{"kind":"changed","revision":"1","p":"${'x'.repeat(300)}"}`,
    ],
  ])('ignores %s', (_case, message) => {
    expect(parseWorkspaceInboxHint(message)).toBeUndefined();
  });

  it('publishes to the workspace channel and fails fast once closed', async () => {
    const { mocks, redis } = fakeRedis(() => Promise.resolve(3));
    const publisher = new RedisWorkspaceInboxHintPublisher(
      { redisUrl: 'redis://localhost:6379', redisTelemetry: telemetry },
      () => redis,
    );
    await expect(
      publisher.publish({ workspaceId, revision: '7' }),
    ).resolves.toEqual({ receivers: 3 });
    expect(mocks.publish).toHaveBeenCalledWith(
      workspaceInboxChannel(workspaceId),
      encodeWorkspaceInboxHint('7'),
    );
    await publisher.close();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    await expect(
      publisher.publish({ workspaceId, revision: '8' }),
    ).rejects.toBeInstanceOf(WorkspaceInboxHintPublishError);
  });

  it('reports a Redis failure or timeout as a publish error', async () => {
    const failing = new RedisWorkspaceInboxHintPublisher(
      { redisUrl: 'redis://localhost:6379', redisTelemetry: telemetry },
      () => fakeRedis(() => Promise.reject(new Error('connection lost'))).redis,
    );
    await expect(
      failing.publish({ workspaceId, revision: '1' }),
    ).rejects.toThrow(new WorkspaceInboxHintPublishError('connection lost'));

    vi.useFakeTimers();
    try {
      const stalled = new RedisWorkspaceInboxHintPublisher(
        {
          redisUrl: 'redis://localhost:6379',
          publishTimeoutMs: 50,
          redisTelemetry: telemetry,
        },
        () => fakeRedis(() => new Promise(() => undefined)).redis,
      );
      const publishing = stalled.publish({ workspaceId, revision: '1' });
      const outcome = expect(publishing).rejects.toThrow(
        'Redis publish timed out',
      );
      await vi.advanceTimersByTimeAsync(50);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });
});
