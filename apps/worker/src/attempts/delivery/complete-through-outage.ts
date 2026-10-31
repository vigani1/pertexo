import type { NodeAttemptRunStore } from '@pertexo/database/attempts';
import { isTransientDatabaseFailure } from '@pertexo/database/platform';

import { waitForCancelableDelay } from '../../runtime/abortable-delay.js';

const RETRY_INTERVAL_MILLIS = 1_000;

/**
 * A finished step's result is only known here, so a database blip must not lose
 * it and turn a known outcome into an unknown one. The lease bounds the wait:
 * once it can have expired, recovery owns the attempt and this gives up.
 */
export function completingThroughOutage(
  runStore: NodeAttemptRunStore,
  leaseDurationSeconds: number,
): NodeAttemptRunStore {
  return Object.freeze({
    ...runStore,
    complete: async (input: Parameters<NodeAttemptRunStore['complete']>[0]) => {
      const giveUpAt = performance.now() + leaseDurationSeconds * 1_000;
      for (;;) {
        try {
          return await runStore.complete(input);
        } catch (error: unknown) {
          const canTryAgain =
            isTransientDatabaseFailure(error) &&
            !input.signal.aborted &&
            performance.now() < giveUpAt;
          if (!canTryAgain) throw error;
          await waitForCancelableDelay(RETRY_INTERVAL_MILLIS, input.signal);
        }
      }
    },
  });
}
