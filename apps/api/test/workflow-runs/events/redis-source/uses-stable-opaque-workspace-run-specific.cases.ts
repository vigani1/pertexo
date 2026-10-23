import type { Redis } from 'ioredis';
import type { RedisTelemetryObserver } from '@pertexo/queue';
import { expect, it, vi } from 'vitest';
import {
  RedisRunEventSource,
  RedisRunEventSourceConfigurationError,
  runEventChannel,
} from '../../../../src/workflow-runs/events/redis-source.js';
import {
  WORKSPACE_ID,
  RUN_ID,
  FakeRedis,
  expectNoListeners,
  sourceWithFake,
} from './fixture.js';

export function registerUsesStableOpaqueWorkspaceRunSpecific(): void {
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
            errorClass:
              outcome === 'rejection'
                ? 'connection'
                : outcome === 'abort'
                  ? 'aborted'
                  : 'timeout',
            operation: 'subscribe',
            outcome: 'failure',
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('rejects an already-aborted subscription without calling Redis subscribe', async () => {
    const fake = new FakeRedis();
    const controller = new AbortController();
    controller.abort();

    await expect(
      sourceWithFake(fake).subscribe({
        runId: RUN_ID,
        signal: controller.signal,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toMatchObject({ name: 'RedisRunEventSubscribeError' });

    expect(fake.subscribeCalls).toBe(0);
    expect(fake.disconnectCalls).toBe(1);
    expectNoListeners(fake);
  });
}
