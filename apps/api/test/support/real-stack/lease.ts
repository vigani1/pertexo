import { Redis } from 'ioredis';
import { setTimeout as delay } from 'node:timers/promises';

// Files run in parallel and rate-limit counters and queues can't be prefixed,
// so each stack leases a whole Redis database that nothing else in the suite
// uses. The compose project owns this Redis alone.
const LEASE_SECONDS = 900;

export async function leaseRedisDatabase(
  redisUrl: string,
  owner: string,
  databases: readonly number[],
): Promise<{
  url: string;
  release: () => Promise<void>;
}> {
  const coordinator = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  const deadline = Date.now() + 240_000;
  try {
    while (Date.now() < deadline) {
      for (const database of databases) {
        const lease = `pertexo:test:security-stack:${String(database)}`;
        const taken = await coordinator.set(
          lease,
          owner,
          'EX',
          LEASE_SECONDS,
          'NX',
        );
        if (taken !== 'OK') continue;
        const parsed = new URL(redisUrl);
        parsed.pathname = `/${String(database)}`;
        const url = parsed.toString();
        await flushRedisDatabase(url);
        return {
          url,
          release: async () => {
            const releasing = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
            try {
              await releasing.del(lease);
            } finally {
              releasing.disconnect();
            }
          },
        };
      }
      await delay(500);
    }
  } finally {
    coordinator.disconnect();
  }
  throw new Error('No Redis database came free for the real-process stack');
}

export async function flushRedisDatabase(url: string): Promise<void> {
  const client = new Redis(url, { maxRetriesPerRequest: 1 });
  try {
    await client.flushdb();
  } finally {
    client.disconnect();
  }
}
