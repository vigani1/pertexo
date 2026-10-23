import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';

import { expect } from 'vitest';
import { RedisRunEventSource } from '../../../../src/workflow-runs/events/redis-source.js';

export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

export const RUN_ID = '33333333-3333-4333-8333-333333333333';

export class FakeRedis extends EventEmitter {
  public disconnected = false;
  public disconnectCalls = 0;
  public pingCalls = 0;
  public subscribeCalls = 0;
  public readonly subscribedChannels: string[] = [];

  public constructor(
    private readonly operations: Readonly<{
      ping?: () => Promise<string>;
      subscribe?: (channel: string, call: number) => Promise<number>;
    }> = {},
  ) {
    super();
  }

  public disconnect(): void {
    this.disconnected = true;
    this.disconnectCalls += 1;
  }

  public ping(): Promise<string> {
    this.pingCalls += 1;
    return this.operations.ping?.() ?? Promise.resolve('PONG');
  }

  public subscribe(channel: string): Promise<number> {
    this.subscribeCalls += 1;
    this.subscribedChannels.push(channel);
    return (
      this.operations.subscribe?.(channel, this.subscribeCalls) ??
      Promise.resolve(1)
    );
  }
}

export function expectNoListeners(fake: FakeRedis): void {
  for (const event of ['message', 'close', 'end', 'ready', 'error']) {
    expect(fake.listenerCount(event)).toBe(0);
  }
}

export function sourceWithFake(
  fake: FakeRedis,
  bufferCapacity = 4,
): RedisRunEventSource {
  return new RedisRunEventSource(
    { bufferCapacity, redisUrl: 'redis://localhost:6379' },
    () => fake as unknown as Redis,
  );
}
