import { EventEmitter } from 'node:events';

import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import {
  RedisRunEventPublisher,
  RedisRunEventPublisherConfigurationError,
  RedisRunEventPublishError,
  encodeRunEventReference,
} from '../../src/executions/redis-run-event-publisher.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

class FakeRedisPublisher extends EventEmitter {
  public disconnected = false;
  public disconnectCalls = 0;
  public readonly publications: { channel: string; payload: string }[] = [];
  public publishImplementation: (
    channel: string,
    payload: string,
  ) => Promise<number> = () => Promise.resolve(2);

  public disconnect(): void {
    this.disconnected = true;
    this.disconnectCalls += 1;
  }

  public publish(channel: string, payload: string): Promise<number> {
    this.publications.push({ channel, payload });
    return this.publishImplementation(channel, payload);
  }
}

describe('Redis run event publisher', () => {
  it('publishes only a bounded event reference on the opaque channel', async () => {
    const fake = new FakeRedisPublisher();
    const publisher = new RedisRunEventPublisher(
      { redisUrl: 'redis://localhost:6379' },
      () => fake as unknown as Redis,
    );

    await expect(
      publisher.publish({
        runId: RUN_ID,
        sequence: 7,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toEqual({ receivers: 2 });
    await expect(
      publisher.resync({ runId: RUN_ID, workspaceId: WORKSPACE_ID }),
    ).resolves.toEqual({ receivers: 2 });
    expect(fake.publications).toHaveLength(2);
    expect(fake.publications[0]?.channel).not.toContain(RUN_ID);
    expect(JSON.parse(fake.publications[0]?.payload ?? '')).toEqual({
      kind: 'event',
      runId: RUN_ID,
      sequence: 7,
      workspaceId: WORKSPACE_ID,
    });
    expect(fake.publications[0]?.payload).not.toContain('payload');
    expect(fake.publications[1]).toEqual({
      channel: fake.publications[0]?.channel,
      payload: JSON.stringify({ kind: 'resync' }),
    });
    await publisher.close();
    expect(fake.disconnected).toBe(true);
  });

  it('rejects invalid configuration and malformed references', async () => {
    expect(
      () => new RedisRunEventPublisher({ redisUrl: 'file:///redis' }),
    ).toThrow(RedisRunEventPublisherConfigurationError);
    expect(() =>
      encodeRunEventReference({
        runId: 'invalid',
        sequence: 1,
        workspaceId: WORKSPACE_ID,
      }),
    ).toThrow();

    const publisher = new RedisRunEventPublisher(
      { redisUrl: 'redis://localhost' },
      () => new FakeRedisPublisher() as unknown as Redis,
    );
    await publisher.close();
    await expect(
      publisher.publish({
        runId: RUN_ID,
        sequence: 1,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow(RedisRunEventPublishError);
  });

  it('closes idempotently and rejects resync without publishing after close', async () => {
    const fake = new FakeRedisPublisher();
    const publisher = new RedisRunEventPublisher(
      { redisUrl: 'redis://localhost:6379' },
      () => fake as unknown as Redis,
    );

    await publisher.close();
    await publisher.close();
    await expect(
      publisher.resync({ runId: RUN_ID, workspaceId: WORKSPACE_ID }),
    ).rejects.toMatchObject({
      name: 'RunEventNotificationPublishError',
      message: 'Run event publisher is closed',
    });
    expect(fake.disconnectCalls).toBe(1);
    expect(fake.publications).toHaveLength(0);
  });

  it('times out a pending publish and safely ignores its late settlement', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeRedisPublisher();
      let settle: ((receivers: number) => void) | undefined;
      fake.publishImplementation = () =>
        new Promise<number>((resolve) => {
          settle = resolve;
        });
      const publisher = new RedisRunEventPublisher(
        { publishTimeoutMs: 25, redisUrl: 'redis://localhost:6379' },
        () => fake as unknown as Redis,
      );

      const publishing = publisher.publish({
        runId: RUN_ID,
        sequence: 1,
        workspaceId: WORKSPACE_ID,
      });
      const rejection = expect(publishing).rejects.toMatchObject({
        name: 'RunEventNotificationPublishError',
        message: 'Redis publish timed out',
      });
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      settle?.(4);
      await Promise.resolve();
      await publisher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['Error', new Error('redis unavailable'), 'redis unavailable'],
    ['primitive', 'redis unavailable', 'Redis publish failed'],
  ] as const)(
    'normalizes a %s Redis rejection at the public boundary',
    async (_kind, failure, message) => {
      const fake = new FakeRedisPublisher();
      // Deliberately model an untrusted Redis adapter rejection.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      fake.publishImplementation = () => Promise.reject(failure);
      const publisher = new RedisRunEventPublisher(
        { redisUrl: 'redis://localhost:6379' },
        () => fake as unknown as Redis,
      );

      await expect(
        publisher.publish({
          runId: RUN_ID,
          sequence: 1,
          workspaceId: WORKSPACE_ID,
        }),
      ).rejects.toMatchObject({
        name: 'RunEventNotificationPublishError',
        message,
      });
      await publisher.close();
    },
  );

  it('isolates throwing Redis telemetry from publish and cleanup', async () => {
    const fake = new FakeRedisPublisher();
    const publisher = new RedisRunEventPublisher(
      {
        redisTelemetry: {
          connectionEvent: () => {
            throw new Error('telemetry unavailable');
          },
          operationFinished: () => {
            throw new Error('telemetry unavailable');
          },
        },
        redisUrl: 'redis://localhost:6379',
      },
      () => fake as unknown as Redis,
    );

    fake.emit('ready');
    await expect(
      publisher.publish({
        runId: RUN_ID,
        sequence: 1,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toEqual({ receivers: 2 });
    await expect(publisher.close()).resolves.toBeUndefined();
    expect(fake.disconnectCalls).toBe(1);
  });

  it('rejects invalid options before constructing Redis', () => {
    const createRedis = vi.fn(
      () => new FakeRedisPublisher() as unknown as Redis,
    );

    expect(
      () =>
        new RedisRunEventPublisher(
          { publishTimeoutMs: 0, redisUrl: 'redis://localhost:6379' },
          createRedis,
        ),
    ).toThrow(RedisRunEventPublisherConfigurationError);
    expect(createRedis).not.toHaveBeenCalled();
  });
});
