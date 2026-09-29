import { randomUUID } from 'node:crypto';

import { RedisWorkspaceInboxHintPublisher } from '@pertexo/queue';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  RedisInboxHintHub,
  type InboxHintSignal,
  type InboxHintSubscription,
} from '../../src/notifications/inbox-hint-hub.js';

const redisUrl = process.env.REDIS_URL;
const enabled =
  process.env.API_SSE_INTEGRATION === 'true' && redisUrl !== undefined;

async function nextSignal(
  subscription: InboxHintSubscription,
): Promise<InboxHintSignal | undefined> {
  const result = await subscription[Symbol.asyncIterator]().next();
  return result.done === true ? undefined : result.value;
}

describe.skipIf(!enabled)('Redis inbox hint hub with real Redis', () => {
  const url = redisUrl ?? 'redis://unused';
  const hub = new RedisInboxHintHub({ redisUrl: url });
  const publisher = new RedisWorkspaceInboxHintPublisher({ redisUrl: url });

  afterAll(async () => {
    await Promise.all([hub.close(), publisher.close()]);
  });

  it('delivers a worker hint to every open inbox of that workspace only', async () => {
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    await hub.checkReadiness();
    const first = await hub.subscribe(workspaceId);
    const second = await hub.subscribe(workspaceId);
    const other = await hub.subscribe(otherWorkspaceId);
    try {
      await expect(
        publisher.publish({ workspaceId, revision: '41' }),
      ).resolves.toEqual({ receivers: 1 });
      await expect(nextSignal(first)).resolves.toEqual({
        kind: 'changed',
        revision: '41',
      });
      await expect(nextSignal(second)).resolves.toEqual({
        kind: 'changed',
        revision: '41',
      });

      // The other workspace hears nothing: its next signal is its own.
      await publisher.publish({ workspaceId: otherWorkspaceId, revision: '7' });
      await expect(nextSignal(other)).resolves.toEqual({
        kind: 'changed',
        revision: '7',
      });
    } finally {
      first.close();
      second.close();
      other.close();
    }
    // Once every inbox of a workspace closes, the process stops listening.
    // The unsubscribe travels on the hub's own connection, so wait for it.
    await vi.waitFor(async () => {
      await expect(
        publisher.publish({ workspaceId, revision: '42' }),
      ).resolves.toEqual({ receivers: 0 });
    });
  });
});
