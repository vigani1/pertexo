export interface OperationTelemetry<Operation extends string = string> {
  measure<T>(operation: Operation, work: () => Promise<T>): Promise<T>;
}

export const NOOP_OPERATION_TELEMETRY: OperationTelemetry = Object.freeze({
  measure: <T>(_operation: string, work: () => Promise<T>): Promise<T> =>
    work(),
});

type OperationOutcome = 'succeeded' | 'failed';
interface MeasurementSpan {
  end(): unknown;
  setAttribute?(name: string, value: string): unknown;
}

type MeasurementOptions<T, Span extends MeasurementSpan> = Readonly<{
  work: () => Promise<T>;
  trace: (run: (span?: Span) => Promise<T>) => Promise<T>;
  operation?: string;
  monotonicNow?: (() => number) | undefined;
  record?: (
    measurement: Readonly<{
      outcome: OperationOutcome;
      seconds: number;
      span: Span | undefined;
    }>,
  ) => void;
}>;

/** Diagnostics may observe an operation, but never replace or repeat it. */
export function measureOperation<T, Span extends MeasurementSpan>(
  options: MeasurementOptions<T, Span>,
): Promise<T> {
  const clock = options.monotonicNow ?? (() => performance.now());
  let operationPromise: Promise<T> | undefined;
  let owningSpan: Span | undefined;
  const measured = async (span?: Span): Promise<T> => {
    const startedAt = safeNow(clock);
    const operation = options.operation;
    if (operation !== undefined)
      safely(() => span?.setAttribute?.('operation', operation));
    const record = (outcome: OperationOutcome): void => {
      const finishedAt = safeNow(clock);
      if (options.operation !== undefined)
        safely(() => span?.setAttribute?.('outcome', outcome));
      safely(() => {
        options.record?.({
          outcome,
          seconds: Math.max(0, finishedAt - startedAt) / 1_000,
          span,
        });
      });
    };
    try {
      const result = await options.work();
      record('succeeded');
      return result;
    } catch (error: unknown) {
      record('failed');
      throw error;
    } finally {
      safely(() => span?.end());
    }
  };
  const runOnce = (span?: Span): Promise<T> => {
    if (operationPromise === undefined) {
      owningSpan = span;
      operationPromise = measured(span);
    } else if (span !== undefined && span !== owningSpan) {
      safely(() => span.end());
    }
    return operationPromise;
  };
  let tracePromise: Promise<T>;
  try {
    tracePromise = options.trace(runOnce);
  } catch {
    return runOnce();
  }
  // A broken tracer may reject, omit its callback, or call it more than once.
  void Promise.resolve(tracePromise).catch(() => undefined);
  return operationPromise ?? runOnce();
}

function safeNow(clock: () => number): number {
  try {
    const value = clock();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function safely(operation: () => unknown): void {
  try {
    operation();
  } catch {
    // Diagnostics cannot change the operation's result or failure.
  }
}
