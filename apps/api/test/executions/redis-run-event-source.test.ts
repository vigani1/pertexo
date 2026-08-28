import { EventEmitter } from 'node:events';

import type { Redis } from 'ioredis';
import type { RedisTelemetryObserver } from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import {
  RedisRunEventSource,
  RedisRunEventSourceConfigurationError,
  runEventChannel,
} from '../../src/executions/redis-run-event-source.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

class FakeRedis extends EventEmitter {
  public disconnected = false;
  public readonly subscribedChannels: string[] = [];

  public disconnect(): void {
    this.disconnected = true;
  }

  public ping(): Promise<string> {
    return Promise.resolve('PONG');
  }

  public subscribe(channel: string): Promise<number> {
    this.subscribedChannels.push(channel);
    return Promise.resolve(1);
  }
}

function sourceWithFake(
  fake: FakeRedis,
  bufferCapacity = 4,
): RedisRunEventSource {
  return new RedisRunEventSource(
    { bufferCapacity, redisUrl: 'redis://localhost:6379' },
    () => fake as unknown as Redis,
  );
}

describe('Redis run event source', () => {
  it('uses a stable opaque workspace/run-specific channel', () => {
    const channel = runEventChannel(WORKSPACE_ID, RUN_ID);
    expect(channel).toBe(runEventChannel(WORKSPACE_ID, RUN_ID));
    expect(channel).not.toContain(WORKSPACE_ID);
    expect(channel).not.toContain(RUN_ID);
    expect(channel).toMatch(/^run-events:v1:[\w-]{43}$/);
  });

  it('rejects unsafe Redis configuration', () => {
    expect(
      () => new RedisRunEventSource({ redisUrl: 'http://localhost' }),
    ).toThrow(RedisRunEventSourceConfigurationError);
    expect(
      () =>
        new RedisRunEventSource({
          bufferCapacity: 4_097,
          redisUrl: 'redis://localhost',
        }),
    ).toThrow(RedisRunEventSourceConfigurationError);
  });

  it('proves Redis connectivity for API readiness without retaining a client', async () => {
    const fake = new FakeRedis();
    const redisTelemetry = {
      connectionEvent: vi.fn(),
      operationFinished: vi.fn(),
    } satisfies RedisTelemetryObserver;
    const source = new RedisRunEventSource(
      { redisTelemetry, redisUrl: 'redis://localhost:6379' },
      () => fake as unknown as Redis,
    );

    await expect(source.checkReadiness()).resolves.toBeUndefined();
    expect(fake.disconnected).toBe(true);
    expect(redisTelemetry.operationFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRole: 'run_event_subscriber',
        operation: 'ping',
        outcome: 'success',
      }),
    );
  });

  it('turns reconnect into a durable resync only after resubscription', async () => {
    const fake = new FakeRedis();
    const redisTelemetry = {
      connectionEvent: vi.fn(),
      operationFinished: vi.fn(),
    } satisfies RedisTelemetryObserver;
    const source = new RedisRunEventSource(
      {
        bufferCapacity: 4,
        redisTelemetry,
        redisUrl: 'redis://localhost:6379',
      },
      () => fake as unknown as Redis,
    );
    const subscription = await source.subscribe({
      runId: RUN_ID,
      signal: new AbortController().signal,
      workspaceId: WORKSPACE_ID,
    });
    expect(fake.subscribedChannels).toHaveLength(1);

    fake.emit('close');
    fake.emit('ready');
    const next = await subscription[Symbol.asyncIterator]().next();

    expect(fake.subscribedChannels).toHaveLength(2);
    expect(next).toEqual({ done: false, value: { kind: 'resync' } });
    expect(redisTelemetry.operationFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRole: 'run_event_subscriber',
        operation: 'subscribe',
        outcome: 'success',
      }),
    );
    expect(redisTelemetry.operationFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRole: 'run_event_subscriber',
        operation: 'resubscribe',
        outcome: 'success',
      }),
    );
    expect(redisTelemetry.connectionEvent).toHaveBeenCalledWith({
      clientRole: 'run_event_subscriber',
      event: 'close',
    });
    expect(
      JSON.stringify(redisTelemetry.operationFinished.mock.calls),
    ).not.toContain(RUN_ID);
    await subscription.close();
  });

  it('isolates observer failures from subscribe and close', async () => {
    const fake = new FakeRedis();
    const source = new RedisRunEventSource(
      {
        redisTelemetry: {
          connectionEvent: () => {
            throw new Error('metrics unavailable');
          },
          operationFinished: () => {
            throw new Error('metrics unavailable');
          },
        },
        redisUrl: 'redis://localhost:6379',
      },
      () => fake as unknown as Redis,
    );

    const subscription = await source.subscribe({
      runId: RUN_ID,
      signal: new AbortController().signal,
      workspaceId: WORKSPACE_ID,
    });
    await expect(subscription.close()).resolves.toBeUndefined();
    expect(fake.disconnected).toBe(true);
  });

  it('drops malformed payloads and coalesces buffer overflow into resync', async () => {
    const fake = new FakeRedis();
    const subscription = await sourceWithFake(fake, 2).subscribe({
      runId: RUN_ID,
      signal: new AbortController().signal,
      workspaceId: WORKSPACE_ID,
    });
    const channel = fake.subscribedChannels[0];
    expect(channel).toBeDefined();

    fake.emit('message', channel, '{malformed');
    for (const sequence of [1, 2, 3]) {
      fake.emit(
        'message',
        channel,
        JSON.stringify({
          kind: 'event',
          runId: RUN_ID,
          sequence,
          workspaceId: WORKSPACE_ID,
        }),
      );
    }

    await expect(subscription[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: false,
      value: { kind: 'resync' },
    });
    await subscription.close();
  });

  it('forwards a worker resync hint on the opaque subscribed channel', async () => {
    const fake = new FakeRedis();
    const subscription = await sourceWithFake(fake).subscribe({
      runId: RUN_ID,
      signal: new AbortController().signal,
      workspaceId: WORKSPACE_ID,
    });
    const channel = fake.subscribedChannels[0];
    expect(channel).toBeDefined();
    fake.emit('message', channel, JSON.stringify({ kind: 'resync' }));

    await expect(subscription[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: false,
      value: { kind: 'resync' },
    });
    await subscription.close();
  });

  it('disconnects and completes the iterator when the request is aborted', async () => {
    const fake = new FakeRedis();
    const controller = new AbortController();
    const subscription = await sourceWithFake(fake).subscribe({
      runId: RUN_ID,
      signal: controller.signal,
      workspaceId: WORKSPACE_ID,
    });
    const pending = subscription[Symbol.asyncIterator]().next();

    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(fake.disconnected).toBe(true);
  });
});
