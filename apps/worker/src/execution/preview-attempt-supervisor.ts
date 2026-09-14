import type {
  PreviewAttemptLease,
  PreviewHeartbeatResult,
} from '@pertexo/database/execution';
import { waitForSupervisorDelay } from '../runtime/abortable-delay.js';

export type PreviewRaceOutcome<T> =
  | Readonly<{ error: unknown; kind: 'error' }>
  | Readonly<{ kind: 'outcome'; outcome: T }>
  | Readonly<{ error: unknown; kind: 'lease_failure' }>
  | 'deadline';

export type PreviewAttemptSupervisor<T> = Readonly<{
  executionSignal: AbortSignal;
  race(invocation: Promise<T>): Promise<PreviewRaceOutcome<T>>;
  stop(): Promise<void>;
}>;

type SupervisorDelay = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

type HeartbeatStore = Readonly<{
  heartbeat(
    input: Readonly<{
      lease: Pick<
        PreviewAttemptLease,
        | 'attemptFenceToken'
        | 'previewAttemptId'
        | 'previewRunId'
        | 'workspaceId'
      >;
      leaseDurationSeconds: number;
      signal?: AbortSignal;
      workerId: string;
    }>,
  ): Promise<PreviewHeartbeatResult>;
}>;

export function startPreviewAttemptSupervisor<T>(
  input: Readonly<{
    contextSignal: AbortSignal;
    heartbeatIntervalMillis: number;
    lease: PreviewAttemptLease;
    leaseDurationSeconds: number;
    runStore: HeartbeatStore;
    workerId: string;
  }>,
  delay: SupervisorDelay = waitForSupervisorDelay,
): PreviewAttemptSupervisor<T> {
  const executionAbort = new AbortController();
  const heartbeatStop = new AbortController();
  const heartbeatStopReason = new Error('Preview heartbeat stopped');
  let notifyContextFailure: ((error: unknown) => void) | undefined;
  const contextFailure = new Promise<
    Readonly<{ error: unknown; kind: 'error' }>
  >((resolve) => {
    notifyContextFailure = (error: unknown): void => {
      resolve({ error, kind: 'error' });
    };
  });
  const contextAborted = (): void => {
    notifyContextFailure?.(input.contextSignal.reason);
  };
  if (input.contextSignal.aborted) contextAborted();
  else
    input.contextSignal.addEventListener('abort', contextAborted, {
      once: true,
    });
  const heartbeatSignal = AbortSignal.any([
    input.contextSignal,
    heartbeatStop.signal,
  ]);
  const executionSignal = AbortSignal.any([
    input.contextSignal,
    executionAbort.signal,
  ]);
  let notifyDeadline: (() => void) | undefined;
  const deadlineHit = new Promise<'deadline'>((resolve) => {
    notifyDeadline = (): void => {
      resolve('deadline');
    };
  });
  const deadlineTimer = setTimeout(
    () => {
      notifyDeadline?.();
      executionAbort.abort();
    },
    Math.max(0, input.lease.executionDeadlineAt.getTime() - Date.now()),
  );
  let notifyLeaseFailure: ((error: unknown) => void) | undefined;
  const leaseFailure = new Promise<
    Readonly<{ error: unknown; kind: 'lease_failure' }>
  >((resolve) => {
    notifyLeaseFailure = (error: unknown): void => {
      resolve({ error, kind: 'lease_failure' });
    };
  });
  const heartbeatLoop = (async (): Promise<void> => {
    try {
      while (!heartbeatSignal.aborted) {
        await delay(input.heartbeatIntervalMillis, heartbeatSignal);
        if (isAborted(heartbeatSignal)) return;
        const beat: PreviewHeartbeatResult = await input.runStore.heartbeat({
          lease: input.lease,
          leaseDurationSeconds: input.leaseDurationSeconds,
          signal: heartbeatSignal,
          workerId: input.workerId,
        });
        if (isAborted(heartbeatSignal)) return;
        if (Date.now() >= beat.runExecutionDeadlineAt.getTime()) {
          notifyDeadline?.();
          executionAbort.abort();
          return;
        }
      }
    } catch (error: unknown) {
      if (heartbeatSignal.aborted && error === heartbeatSignal.reason) return;
      // Durable reconciliation owns the truthful terminal state after lease loss.
      notifyLeaseFailure?.(error);
      executionAbort.abort();
    }
  })();
  let invocationSettlement: Promise<PreviewRaceOutcome<T>> | undefined;
  let stopPromise: Promise<void> | undefined;
  return Object.freeze({
    executionSignal,
    race: async (invocation: Promise<T>): Promise<PreviewRaceOutcome<T>> => {
      if (invocationSettlement !== undefined)
        throw new TypeError('Preview supervisor can own only one invocation');
      invocationSettlement = invocation.then(
        (outcome): PreviewRaceOutcome<T> => ({ kind: 'outcome', outcome }),
        (error: unknown): PreviewRaceOutcome<T> => ({ error, kind: 'error' }),
      );
      return await Promise.race<PreviewRaceOutcome<T>>([
        invocationSettlement,
        contextFailure,
        deadlineHit,
        leaseFailure,
      ]);
    },
    stop: (): Promise<void> => {
      stopPromise ??= (async (): Promise<void> => {
        clearTimeout(deadlineTimer);
        input.contextSignal.removeEventListener('abort', contextAborted);
        heartbeatStop.abort(heartbeatStopReason);
        await heartbeatLoop;
        if (invocationSettlement !== undefined) await invocationSettlement;
      })();
      return stopPromise;
    },
  });
}
