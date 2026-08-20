import { EventEmitter } from 'node:events';

import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

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
  public readonly publications: { channel: string; payload: string }[] = [];

  public disconnect(): void {
    this.disconnected = true;
  }

  public publish(channel: string, payload: string): Promise<number> {
    this.publications.push({ channel, payload });
    return Promise.resolve(2);
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
    expect(fake.publications).toHaveLength(1);
    expect(fake.publications[0]?.channel).not.toContain(RUN_ID);
    expect(JSON.parse(fake.publications[0]?.payload ?? '')).toEqual({
      kind: 'event',
      runId: RUN_ID,
      sequence: 7,
      workspaceId: WORKSPACE_ID,
    });
    expect(fake.publications[0]?.payload).not.toContain('payload');
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
});
