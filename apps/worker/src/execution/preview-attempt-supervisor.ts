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
): PreviewAttemptSupervisor<T> {
  const executionAbort = new AbortController();
  const heartbeatStop = new AbortController();
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
      executionAbort.abort();
      notifyDeadline?.();
    },
    Math.max(0, input.lease.executionDeadlineAt.getTime() - Date.now()),
  );
  type HeartbeatEnd = 'stopped' | 'lease_lost';
  let endHeartbeat: ((end: HeartbeatEnd) => void) | undefined;
  const heartbeatDone = new Promise<HeartbeatEnd>((resolve) => {
    endHeartbeat = resolve;
  });
  let notifyLeaseFailure: ((error: unknown) => void) | undefined;
  const leaseFailure = new Promise<
    Readonly<{ error: unknown; kind: 'lease_failure' }>
  >((resolve) => {
    notifyLeaseFailure = (error: unknown): void => {
      resolve({ error, kind: 'lease_failure' });
    };
  });
  void (async (): Promise<void> => {
    while (!heartbeatSignal.aborted) {
      await waitForSupervisorDelay(
        input.heartbeatIntervalMillis,
        heartbeatSignal,
      );
      let beat: PreviewHeartbeatResult;
      try {
        beat = await input.runStore.heartbeat({
          lease: input.lease,
          leaseDurationSeconds: input.leaseDurationSeconds,
          signal: heartbeatSignal,
          workerId: input.workerId,
        });
      } catch (error: unknown) {
        // Durable reconciliation owns the truthful terminal state after lease loss.
        executionAbort.abort();
        notifyLeaseFailure?.(error);
        endHeartbeat?.('lease_lost');
        return;
      }
      if (Date.now() >= beat.runExecutionDeadlineAt.getTime()) {
        executionAbort.abort();
        notifyDeadline?.();
        endHeartbeat?.('stopped');
        return;
      }
    }
    endHeartbeat?.('stopped');
  })();
  return Object.freeze({
    executionSignal,
    race: async (invocation: Promise<T>): Promise<PreviewRaceOutcome<T>> =>
      await Promise.race<PreviewRaceOutcome<T>>([
        invocation.then(
          (outcome): PreviewRaceOutcome<T> => ({ kind: 'outcome', outcome }),
          (error: unknown): PreviewRaceOutcome<T> => ({ error, kind: 'error' }),
        ),
        deadlineHit,
        leaseFailure,
      ]),
    stop: async (): Promise<void> => {
      clearTimeout(deadlineTimer);
      heartbeatStop.abort();
      await heartbeatDone;
    },
  });
}
