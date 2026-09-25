export const CONNECTION_OPERATION = Object.freeze({
  list: 'connection.list',
  read: 'connection.read',
  create: 'connection.create',
  rotate: 'connection.secret.rotate',
  revoke: 'connection.revoke',
  test: 'connection.test',
  slackChannelLookup: 'connection.slack_channel.lookup',
  destinationCreate: 'failure_notification_destination.create',
  destinationAppend: 'failure_notification_destination.version.append',
  destinationStatus: 'failure_notification_destination.status',
  policySet: 'workflow.failure_notification_policy.set',
  policyClear: 'workflow.failure_notification_policy.clear',
} as const);

export type ConnectionOperation =
  (typeof CONNECTION_OPERATION)[keyof typeof CONNECTION_OPERATION];
export type ConnectionOutcome = 'failed' | 'succeeded';

export interface ConnectionTelemetry {
  measure<T>(
    operation: ConnectionOperation,
    work: () => Promise<T>,
  ): Promise<T>;
}

export const NOOP_CONNECTION_TELEMETRY: ConnectionTelemetry = Object.freeze({
  measure: <T>(
    _operation: ConnectionOperation,
    work: () => Promise<T>,
  ): Promise<T> => work(),
});

export type ConnectionTelemetryOptions = Readonly<{
  count(operation: ConnectionOperation, outcome: ConnectionOutcome): void;
  duration(
    operation: ConnectionOperation,
    outcome: ConnectionOutcome,
    seconds: number,
  ): void;
  trace<T>(operation: ConnectionOperation, work: () => Promise<T>): Promise<T>;
  monotonicNow?: () => number;
}>;

export function createConnectionTelemetry(
  options: ConnectionTelemetryOptions,
): ConnectionTelemetry {
  const now = options.monotonicNow ?? (() => performance.now());
  return Object.freeze({
    measure: <T>(
      operation: ConnectionOperation,
      work: () => Promise<T>,
    ): Promise<T> => {
      let operationPromise: Promise<T> | undefined;
      const measured = async (): Promise<T> => {
        const startedAt = safeNow(now);
        try {
          const result = await work();
          record('succeeded', startedAt);
          return result;
        } catch (error: unknown) {
          record('failed', startedAt);
          throw error;
        }
      };
      const runOperationOnce = (): Promise<T> => {
        operationPromise ??= measured();
        return operationPromise;
      };
      let tracePromise: Promise<T> | undefined;
      try {
        tracePromise = options.trace(operation, runOperationOnce);
      } catch {
        return runOperationOnce();
      }
      // The trace adapter is diagnostic, not the authority for the command.
      // It gets the same lazy promise on every callback, while a trace that
      // omits, duplicates, or rejects its callback cannot replace or repeat it.
      void Promise.resolve(tracePromise).catch(() => undefined);
      return operationPromise ?? runOperationOnce();

      function record(outcome: ConnectionOutcome, startedAt: number): void {
        try {
          options.count(operation, outcome);
        } catch {
          // Each diagnostic sink is independent of command truth and its peer.
        }
        try {
          options.duration(
            operation,
            outcome,
            Math.max(0, safeNow(now) - startedAt) / 1_000,
          );
        } catch {
          // Diagnostics cannot change connection command truth.
        }
      }
    },
  });
}

function safeNow(clock: () => number): number {
  try {
    const value = clock();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}
