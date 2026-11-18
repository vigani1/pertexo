import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { RedisTelemetryObserver } from '@pertexo/queue/server';
import {
  RedisRunEventSource,
  RedisRunEventSourceConfigurationError,
  runEventChannel,
} from '../../../src/workflow-runs/events/redis-source.js';
import {
  WORKSPACE_ID,
  RUN_ID,
  FakeRedis,
  expectNoListeners,
  sourceWithFake,
} from './redis-source.fixture.js';

function expectedSubscriptionError(outcome: string) {
  if (outcome === 'rejection') return 'connection';
  if (outcome === 'abort') return 'aborted';
  return 'timeout';
}

/**
 * Sharing one connection, re-reads after a lost connection, worker re-read
 * hints, oversize and malformed hints, backlog overflow, readiness and an
 * abandoned page run against Redis in shared-subscriber.integration.test.ts.
 * These cases stay because Redis cannot be made to reject one subscribe or
 * resubscribe on demand, and only a test holding the client sees its listeners
 * and a throwing telemetry observer.
 */
describe('Redis run event source', () => {
  it('uses a stable opaque workspace/run-specific channel', () => {
    const channel = runEventChannel(WORKSPACE_ID, RUN_ID);
    expect(channel).toBe(runEventChannel(WORKSPACE_ID, RUN_ID));
    expect(channel).not.toContain(WORKSPACE_ID);
    expect(channel).not.toContain(RUN_ID);
    expect(channel).toMatch(/^run-events:[\w-]{43}$/);
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

  it.each(['timeout', 'rejection'] as const)(
    'releases the readiness client after ping %s and observes a late settlement',
    async (outcome) => {
      vi.useFakeTimers();
      try {
        const ping = Promise.withResolvers<string>();
        const failure = new Error('ping rejected');
        const fake = new FakeRedis({ ping: () => ping.promise });
        const redisTelemetry = {
          connectionEvent: vi.fn(),
          operationFinished: vi.fn(),
        } satisfies RedisTelemetryObserver;
        const source = new RedisRunEventSource(
          {
            redisTelemetry,
            redisUrl: 'redis://localhost:6379',
            subscribeTimeoutMs: 25,
          },
          () => fake as unknown as Redis,
        );
        const readiness = source.checkReadiness();
        const observedReadiness = readiness.catch((error: unknown) => error);

        if (outcome === 'timeout') {
          await vi.advanceTimersByTimeAsync(25);
          await expect(observedReadiness).resolves.toMatchObject({
            name: 'RedisRunEventSubscribeError',
          });
          ping.resolve('PONG');
        } else {
          ping.reject(failure);
          await expect(observedReadiness).resolves.toBe(failure);
        }
        await Promise.resolve();

        expect(fake.disconnectCalls).toBe(1);
        expectNoListeners(fake);
        expect(redisTelemetry.operationFinished).toHaveBeenCalledWith(
          expect.objectContaining({
            errorClass: outcome === 'timeout' ? 'timeout' : 'connection',
            operation: 'ping',
            outcome: 'failure',
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(['timeout', 'rejection', 'abort'] as const)(
    'does not retain a client after initial subscribe %s and observes late work',
    async (outcome) => {
      vi.useFakeTimers();
      try {
        const subscribe = Promise.withResolvers<number>();
        const failure = new Error('subscribe rejected');
        const fake = new FakeRedis({ subscribe: () => subscribe.promise });
        const redisTelemetry = {
          connectionEvent: vi.fn(),
          operationFinished: vi.fn(),
        } satisfies RedisTelemetryObserver;
        const source = new RedisRunEventSource(
          {
            redisTelemetry,
            redisUrl: 'redis://localhost:6379',
            subscribeTimeoutMs: 25,
          },
          () => fake as unknown as Redis,
        );
        const controller = new AbortController();
        const pending = source.subscribe({
          runId: RUN_ID,
          signal: controller.signal,
          workspaceId: WORKSPACE_ID,
        });
        const observedSubscription = pending.catch((error: unknown) => error);

        if (outcome === 'timeout') {
          await vi.advanceTimersByTimeAsync(25);
        } else if (outcome === 'abort') {
          controller.abort();
        } else {
          subscribe.reject(failure);
        }

        if (outcome === 'rejection') {
          await expect(observedSubscription).resolves.toBe(failure);
        } else {
          await expect(observedSubscription).resolves.toMatchObject({
            name: 'RedisRunEventSubscribeError',
          });
        }
        if (outcome !== 'rejection') subscribe.resolve(1);
        await Promise.resolve();

        expect(fake.disconnectCalls).toBe(1);
        expectNoListeners(fake);
        expect(redisTelemetry.operationFinished).toHaveBeenCalledWith(
          expect.objectContaining({
            errorClass: expectedSubscriptionError(outcome),
            operation: 'subscribe',
            outcome: 'failure',
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

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

  it('makes repeated close idempotent, removes listeners, and completes iterators', async () => {
    const fake = new FakeRedis();
    const subscription = await sourceWithFake(fake).subscribe({
      runId: RUN_ID,
      signal: new AbortController().signal,
      workspaceId: WORKSPACE_ID,
    });
    const iterator = subscription[Symbol.asyncIterator]();

    await Promise.all([subscription.close(), subscription.close()]);

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(fake.disconnectCalls).toBe(1);
    expectNoListeners(fake);
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
