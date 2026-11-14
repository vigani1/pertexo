import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { TIMED_OUT, bounded } from '../redis/bounded-operation.js';

/** Teardown after a failed or forced drain waits this long per connection. */
const FORCED_TEARDOWN_TIMEOUT_MS = 1_000;

/** Whether BullMQ's worker closed within the drain's deadline. */
export async function closeWorker(
  worker: Worker<unknown, void>,
  { forced, deadline }: Readonly<{ forced: boolean; deadline: number }>,
): Promise<boolean> {
  try {
    const closeResult = await bounded(
      worker.close(forced),
      forced ? FORCED_TEARDOWN_TIMEOUT_MS : Math.max(1, deadline - Date.now()),
    );
    return closeResult !== TIMED_OUT;
  } catch {
    return false;
  }
}

/** Whether the consumer's own Redis connection quit cleanly rather than being cut. */
export async function closeRedis(
  worker: Worker<unknown, void>,
  redis: Redis,
  { workerClosed }: Readonly<{ workerClosed: boolean }>,
): Promise<boolean> {
  if (!workerClosed) {
    try {
      await bounded(worker.disconnect(), FORCED_TEARDOWN_TIMEOUT_MS);
    } catch {
      // The owned connection below still disconnects. This bounded call is the
      // best-effort teardown of BullMQ's own blocking connection.
    }
    redis.disconnect();
    return true;
  }
  try {
    const quitResult = await bounded(redis.quit(), FORCED_TEARDOWN_TIMEOUT_MS);
    if (quitResult !== TIMED_OUT) return true;
  } catch {
    // Fall through to the defensive disconnect below.
  }
  redis.disconnect();
  return false;
}
