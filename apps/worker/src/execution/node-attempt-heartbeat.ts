import type {
  NodeAttemptLease,
  NodeAttemptRunStore,
} from '@pertexo/database/execution';
import { waitForCancelableDelay } from '../runtime/abortable-delay.js';
import { NodeAttemptHandlerStateError } from './node-attempt-handler-state-error.js';

type HeartbeatFailure =
  Readonly<{ failed: false }> | Readonly<{ error: unknown; failed: true }>;

export type NodeAttemptHeartbeat = Readonly<{
  executionSignal: AbortSignal;
  durableAbortReason(): 'canceled' | 'timed_out' | undefined;
  failure(): HeartbeatFailure;
  stop(): Promise<void>;
}>;

/** One owned loop; stop always joins it before the handler releases execution. */
export function startNodeAttemptHeartbeat(
  dependencies: Readonly<{
    heartbeatIntervalMillis: number;
    leaseDurationSeconds: number;
    runStore: Pick<NodeAttemptRunStore, 'heartbeat'>;
  }>,
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
        if (result.abortRequested) {
          if (result.abortReason === undefined)
            throw new NodeAttemptHandlerStateError('control_reason_missing');
          abortReason = result.abortReason;
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
