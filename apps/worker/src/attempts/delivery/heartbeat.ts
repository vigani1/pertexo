import type { NodeAttemptLease } from '@pertexo/database/attempts';
import { isTransientDatabaseFailure } from '@pertexo/database/platform';

import { waitForCancelableDelay } from '../../runtime/abortable-delay.js';

import type {
  NodeAttemptHandlerDependencies,
  HeartbeatFailure,
  NodeAttemptHeartbeat,
} from './contract.js';

const OUTAGE_RETRY_INTERVAL_MILLIS = 1_000;

export function startNodeAttemptHeartbeat(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  contextSignal: AbortSignal,
): NodeAttemptHeartbeat {
  const executionAbort = new AbortController();
  const heartbeatStop = new AbortController();
  const heartbeatSignal = AbortSignal.any([
    contextSignal,
    heartbeatStop.signal,
  ]);
  const executionSignal = AbortSignal.any([
    contextSignal,
    executionAbort.signal,
  ]);
  let abortReason: 'canceled' | 'timed_out' | undefined;
  let heartbeatFailure: HeartbeatFailure = Object.freeze({ failed: false });
  const leaseMillis = dependencies.leaseDurationSeconds * 1_000;
  const heartbeat = (async (): Promise<void> => {
    try {
      let renewedAt = performance.now();
      let delay = dependencies.heartbeatIntervalMillis;
      while (!heartbeatSignal.aborted) {
        await waitForCancelableDelay(delay, heartbeatSignal);
        try {
          const result = await dependencies.runStore.heartbeat({
            lease,
            leaseDurationSeconds: dependencies.leaseDurationSeconds,
            signal: heartbeatSignal,
          });
          if (result.control.kind === 'abort') {
            abortReason = result.control.reason;
            executionAbort.abort();
            return;
          }
          renewedAt = performance.now();
          delay = dependencies.heartbeatIntervalMillis;
        } catch (error: unknown) {
          // A database blip says nothing about who owns the step, so the
          // provider call keeps going for as long as the lease can still hold.
          const leaseCanStillHold =
            isTransientDatabaseFailure(error) &&
            performance.now() - renewedAt < leaseMillis;
          if (!leaseCanStillHold) throw error;
          delay = Math.min(delay, OUTAGE_RETRY_INTERVAL_MILLIS);
        }
      }
    } catch (error: unknown) {
      if (!heartbeatStop.signal.aborted && !contextSignal.aborted) {
        heartbeatFailure = Object.freeze({ error, failed: true });
        executionAbort.abort();
      }
    }
  })();
  return Object.freeze({
    executionSignal,
    durableAbortReason: () => abortReason,
    failure: () => heartbeatFailure,
    stop: async (): Promise<void> => {
      heartbeatStop.abort();
      await heartbeat;
    },
  });
}
