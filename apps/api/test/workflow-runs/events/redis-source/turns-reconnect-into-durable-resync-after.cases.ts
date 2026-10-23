import type { Redis } from 'ioredis';
import type { RedisTelemetryObserver } from '@pertexo/queue';
import { expect, it, vi } from 'vitest';
import { RedisRunEventSource } from '../../../../src/workflow-runs/events/redis-source.js';
import { WORKSPACE_ID, RUN_ID, FakeRedis, sourceWithFake } from './fixture.js';

export function registerTurnsReconnectIntoDurableResyncAfter(): void {
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

  it('drops wrong-channel and oversize hints while accepting a later valid hint', async () => {
    const fake = new FakeRedis();
    const subscription = await sourceWithFake(fake).subscribe({
      runId: RUN_ID,
      signal: new AbortController().signal,
      workspaceId: WORKSPACE_ID,
    });
    const channel = fake.subscribedChannels[0];
    expect(channel).toBeDefined();

    fake.emit(
      'message',
      'run-events:wrong-channel',
      JSON.stringify({ kind: 'resync' }),
    );
    fake.emit(
      'message',
      channel,
      `${JSON.stringify({ kind: 'resync' })}${'x'.repeat(513)}`,
    );
    fake.emit('message', channel, JSON.stringify({ kind: 'resync' }));

    await expect(subscription[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: false,
      value: { kind: 'resync' },
    });
    await subscription.close();
  });

  it('recovers after a rejected resubscribe and only then emits resync', async () => {
    const resubscribeFailure = new Error('resubscribe rejected');
    const fake = new FakeRedis({
      subscribe: (_channel, call) =>
        call === 2 ? Promise.reject(resubscribeFailure) : Promise.resolve(1),
    });
    const redisTelemetry = {
      connectionEvent: vi.fn(),
      operationFinished: vi.fn(),
    } satisfies RedisTelemetryObserver;
    const source = new RedisRunEventSource(
      { redisTelemetry, redisUrl: 'redis://localhost:6379' },
      () => fake as unknown as Redis,
    );
    const subscription = await source.subscribe({
      runId: RUN_ID,
      signal: new AbortController().signal,
      workspaceId: WORKSPACE_ID,
    });

    fake.emit('close');
    fake.emit('ready');
    await vi.waitFor(() => {
      expect(fake.subscribeCalls).toBe(2);
    });
    await vi.waitFor(() => {
      expect(redisTelemetry.operationFinished).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'resubscribe',
          outcome: 'failure',
        }),
      );
    });
    fake.emit('ready');
    await vi.waitFor(() => {
      expect(fake.subscribeCalls).toBe(3);
    });

    await expect(subscription[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: false,
      value: { kind: 'resync' },
    });
    expect(redisTelemetry.operationFinished).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'resubscribe', outcome: 'success' }),
    );
    await subscription.close();
  });
}
