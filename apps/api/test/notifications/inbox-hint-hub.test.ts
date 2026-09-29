import { EventEmitter } from 'node:events';

import type { Redis } from 'ioredis';
import {
  encodeWorkspaceInboxHint,
  workspaceInboxChannel,
} from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import {
  RedisInboxHintHub,
  type InboxHintSignal,
  type InboxHintSubscription,
} from '../../src/notifications/inbox-hint-hub.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222';

class FakeRedis extends EventEmitter {
  public readonly subscribed: string[] = [];
  public readonly unsubscribed: string[] = [];
  public disconnected = false;

  public constructor(
    private readonly subscribeResult: () => Promise<number> = () =>
      Promise.resolve(1),
  ) {
    super();
  }

  public subscribe(channel: string): Promise<number> {
    this.subscribed.push(channel);
    return this.subscribeResult();
  }

  public unsubscribe(channel: string): Promise<number> {
    this.unsubscribed.push(channel);
    return Promise.resolve(0);
  }

  public ping(): Promise<string> {
    return Promise.resolve('PONG');
  }

  public disconnect(): void {
    this.disconnected = true;
  }

  public deliver(workspaceId: string, message: string): void {
    this.emit('message', workspaceInboxChannel(workspaceId), message);
  }
}

const telemetry = { connectionEvent: vi.fn(), operationFinished: vi.fn() };

function hub(fake: FakeRedis, subscribeTimeoutMs = 5_000) {
  return new RedisInboxHintHub(
    {
      redisUrl: 'redis://localhost:6379',
      subscribeTimeoutMs,
      redisTelemetry: telemetry,
    },
    () => fake as unknown as Redis,
  );
}

async function next(
  subscription: InboxHintSubscription,
): Promise<IteratorResult<InboxHintSignal>> {
  return subscription[Symbol.asyncIterator]().next();
}

describe('Redis inbox hint hub', () => {
  it('shares one channel subscription per workspace across open inboxes', async () => {
    const fake = new FakeRedis();
    const hints = hub(fake);
    const first = await hints.subscribe(WORKSPACE);
    const second = await hints.subscribe(WORKSPACE);
    const other = await hints.subscribe(OTHER_WORKSPACE);
    expect(fake.subscribed).toEqual([
      workspaceInboxChannel(WORKSPACE),
      workspaceInboxChannel(OTHER_WORKSPACE),
    ]);

    fake.deliver(WORKSPACE, encodeWorkspaceInboxHint('5'));
    await expect(next(first)).resolves.toEqual({
      done: false,
      value: { kind: 'changed', revision: '5' },
    });
    await expect(next(second)).resolves.toEqual({
      done: false,
      value: { kind: 'changed', revision: '5' },
    });

    first.close();
    expect(fake.unsubscribed).toEqual([]);
    second.close();
    expect(fake.unsubscribed).toEqual([workspaceInboxChannel(WORKSPACE)]);
    other.close();
    await hints.close();
    expect(fake.disconnected).toBe(true);
  });

  it('keeps only the newest signal for a slow reader', async () => {
    const fake = new FakeRedis();
    const hints = hub(fake);
    const subscription = await hints.subscribe(WORKSPACE);
    fake.deliver(WORKSPACE, encodeWorkspaceInboxHint('1'));
    fake.deliver(WORKSPACE, encodeWorkspaceInboxHint('2'));
    fake.deliver(WORKSPACE, encodeWorkspaceInboxHint('3'));
    await expect(next(subscription)).resolves.toEqual({
      done: false,
      value: { kind: 'changed', revision: '3' },
    });
    subscription.close();
    await expect(next(subscription)).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await hints.close();
  });

  it('ignores invalid hints and tells every open inbox to resync after a reconnect', async () => {
    const fake = new FakeRedis();
    const hints = hub(fake);
    const subscription = await hints.subscribe(WORKSPACE);
    fake.deliver(WORKSPACE, '{"kind":"changed","revision":"1","extra":true}');
    fake.deliver(WORKSPACE, 'not json');
    fake.emit('ready');
    fake.emit('close');
    fake.emit('ready');
    await expect(next(subscription)).resolves.toEqual({
      done: false,
      value: { kind: 'resync' },
    });
    // A later change folds into a pending resync rather than replacing it.
    fake.emit('close');
    fake.emit('ready');
    fake.deliver(WORKSPACE, encodeWorkspaceInboxHint('9'));
    await expect(next(subscription)).resolves.toEqual({
      done: false,
      value: { kind: 'resync' },
    });
    await hints.close();
    await expect(next(subscription)).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('fails a subscription that Redis does not confirm in time and retries later', async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const fake = new FakeRedis(() => {
        attempt += 1;
        return attempt === 1
          ? new Promise(() => undefined)
          : Promise.resolve(1);
      });
      const hints = hub(fake, 50);
      const failing = hints.subscribe(WORKSPACE);
      const outcome = expect(failing).rejects.toThrow(
        'Redis inbox hint subscription timed out',
      );
      await vi.advanceTimersByTimeAsync(50);
      await outcome;
      const subscription = await hints.subscribe(WORKSPACE);
      expect(fake.subscribed).toHaveLength(2);
      subscription.close();
      await hints.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses new subscriptions once closed', async () => {
    const hints = hub(new FakeRedis());
    await hints.close();
    await expect(hints.subscribe(WORKSPACE)).rejects.toThrow(
      'Inbox hint hub is closed',
    );
  });
});
