export const CONNECTION_OPERATION = Object.freeze({
  create: 'connection.create',
  rotate: 'connection.secret.rotate',
  revoke: 'connection.revoke',
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
      try {
        return options.trace(operation, measured);
      } catch {
        return measured();
      }

      function record(outcome: ConnectionOutcome, startedAt: number): void {
        try {
          options.count(operation, outcome);
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
