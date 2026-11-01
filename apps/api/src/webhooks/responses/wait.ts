import { setTimeout as delay } from 'node:timers/promises';
import type {
  WebhookResponseScope,
  WebhookResponseSnapshot,
} from '@pertexo/core/triggers';

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
      const expiresAt = performance.now() + input.seconds * 1000;
      const deadline = new AbortController();
      const timer = setTimeout(() => {
        deadline.abort();
      }, input.seconds * 1000);
      const signal = AbortSignal.any([
        input.signal,
        closing.signal,
        deadline.signal,
      ]);
      let readAt = performance.now();
      try {
        for (;;) {
          signal.throwIfAborted();
          const now = performance.now();
          if (now >= expiresAt) return null;
          if (now < readAt) {
            // Timers may wake early: elapsed monotonic time owns the read budget.
            await delay(
              Math.ceil(Math.min(readAt, expiresAt) - now),
              undefined,
              { signal },
            );
            continue;
          }
          const result = await read({
            workspaceId: input.workspaceId,
            runId: input.runId,
            signal,
          });
          signal.throwIfAborted();
          if (performance.now() >= expiresAt) return null;
          if (result.state !== 'pending') return result;
          readAt = performance.now() + READ_INTERVAL_MS;
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
