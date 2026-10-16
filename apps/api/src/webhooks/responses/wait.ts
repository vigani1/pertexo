import { setTimeout as delay } from 'node:timers/promises';
import type {
  WebhookResponseScope,
  WebhookResponseSnapshot,
} from '@pertexo/database/triggers';

const MAX_WAITS = 32;
const READ_INTERVAL_MS = 250;
export type WebhookResponseWaiter = ReturnType<
  typeof createWebhookResponseWaiter
>;

/** Only the wait budget is local; PostgreSQL owns every response. */
export function createWebhookResponseWaiter(
  read: (input: WebhookResponseScope) => Promise<WebhookResponseSnapshot>,
) {
  const closing = new AbortController();
  let active = 0;
  return {
    close: () => {
      closing.abort();
    },
    wait: async (
      input: WebhookResponseScope &
        Readonly<{ seconds: number; signal: AbortSignal }>,
    ): Promise<WebhookResponseSnapshot | null> => {
      if (active >= MAX_WAITS || closing.signal.aborted || input.signal.aborted)
        return null;
      active++;
      const deadline = new AbortController();
      const timer = setTimeout(() => {
        deadline.abort();
      }, input.seconds * 1000);
      const signal = AbortSignal.any([
        input.signal,
        closing.signal,
        deadline.signal,
      ]);
      try {
        for (;;) {
          signal.throwIfAborted();
          const result = await read({
            workspaceId: input.workspaceId,
            runId: input.runId,
            signal,
          });
          signal.throwIfAborted();
          if (result.state !== 'pending') return result;
          await delay(READ_INTERVAL_MS, undefined, { signal });
        }
      } catch (error) {
        if (signal.aborted) return null;
        throw error;
      } finally {
        clearTimeout(timer);
        active--;
      }
    },
  };
}
