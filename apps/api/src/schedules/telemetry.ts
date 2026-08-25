export type ScheduleOperation =
  'schedule.list' | 'schedule.enable' | 'schedule.disable';

export interface ScheduleTelemetry {
  measure<T>(operation: ScheduleOperation, work: () => Promise<T>): Promise<T>;
}

export const NOOP_SCHEDULE_TELEMETRY: ScheduleTelemetry = Object.freeze({
  measure: <T>(_operation: ScheduleOperation, work: () => Promise<T>) => work(),
});

export function createScheduleTelemetry(
  input: Readonly<{
    count(operation: ScheduleOperation, outcome: 'succeeded' | 'failed'): void;
    duration(
      operation: ScheduleOperation,
      outcome: 'succeeded' | 'failed',
      seconds: number,
    ): void;
  }>,
): ScheduleTelemetry {
  return Object.freeze({
    measure: async <T>(
      operation: ScheduleOperation,
      work: () => Promise<T>,
    ) => {
      const started = performance.now();
      try {
        const result = await work();
        record('succeeded');
        return result;
      } catch (error: unknown) {
        record('failed');
        throw error;
      }
      function record(outcome: 'succeeded' | 'failed') {
        try {
          input.count(operation, outcome);
          input.duration(
            operation,
            outcome,
            Math.max(0, performance.now() - started) / 1_000,
          );
        } catch {
          // Diagnostics cannot change schedule command truth.
        }
      }
    },
  });
}
