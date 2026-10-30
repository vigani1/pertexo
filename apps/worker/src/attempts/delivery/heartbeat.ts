import type { NodeAttemptLease } from '@pertexo/database/attempts';

import { waitForCancelableDelay } from '../../runtime/abortable-delay.js';

import type {
  NodeAttemptHandlerDependencies,
  HeartbeatFailure,
  NodeAttemptHeartbeat,
} from './contract.js';

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
  const heartbeat = (async (): Promise<void> => {
    try {
      while (!heartbeatSignal.aborted) {
        await waitForCancelableDelay(
          dependencies.heartbeatIntervalMillis,
          heartbeatSignal,
        );
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
