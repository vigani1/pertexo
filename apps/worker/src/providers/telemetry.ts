import {
  metrics,
  SpanStatusCode,
  trace,
  type Meter,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

export type ProviderOperationFailure = Readonly<{
  outcome: string;
  errorClass: string;
  possiblyDispatched: boolean;
}>;

export type ProviderOperationTelemetry<Output> = Readonly<{
  measure(work: () => Promise<Output>): Promise<Output>;
}>;

function promiseFrom<T>(work: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error: unknown) {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- provider contracts preserve arbitrary rejection identity.
    return Promise.reject(error);
  }
}

function observeDiagnosticPromise(value: Promise<unknown>): void {
  try {
    void Promise.resolve(value).catch(() => undefined);
  } catch {
    // Even a hostile diagnostic thenable cannot affect provider work.
  }
}

/**
 * A trace adapter may fail before or after invoking its callback. Capture the
 * one business promise independently so neither case can rerun or replace it.
 */
export function runProviderWorkOnceWithOptionalTrace<Output, Context>(
  work: (context: Context | undefined) => Promise<Output>,
  traceWork: (
    callback: (context: Context) => Promise<Output>,
  ) => Promise<Output>,
): Promise<Output> {
  let workPromise: Promise<Output> | undefined;
  const invoke = (context: Context | undefined): Promise<Output> => {
    workPromise ??= promiseFrom(() => work(context));
    return workPromise;
  };
  let tracePromise: Promise<Output>;
  try {
    tracePromise = traceWork((context) => invoke(context));
  } catch {
    return workPromise ?? invoke(undefined);
  }
  const result = workPromise ?? invoke(undefined);
  if (tracePromise !== result) observeDiagnosticPromise(tracePromise);
  return result;
}

function recordDiagnostic(operation: () => void): void {
  try {
    operation();
  } catch {
    // Diagnostics cannot change provider execution truth.
  }
}

function monotonicNow(): number {
  try {
    const value = performance.now();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function failureAttributes(
  input: Readonly<{
    classifyFailure(error: unknown): ProviderOperationFailure | undefined;
    operationKey: string;
    providerKey: string;
  }>,
  error: unknown,
): Record<string, string | boolean> {
  try {
    const failure = input.classifyFailure(error);
    return {
      provider_key: input.providerKey,
      operation_key: input.operationKey,
      outcome: failure?.outcome ?? 'failed',
      error_class: failure?.errorClass ?? 'internal',
      possibly_dispatched: failure?.possiblyDispatched ?? false,
    };
  } catch {
    return {
      provider_key: input.providerKey,
      operation_key: input.operationKey,
      outcome: 'failed',
      error_class: 'internal',
      possibly_dispatched: false,
    };
  }
}

export function createProductionProviderTelemetry<Output>(
  input: Readonly<{
    instrumentationName: string;
    spanName: string;
    providerKey: string;
    operationKey: string;
    classifyFailure(error: unknown): ProviderOperationFailure | undefined;
    meter?: Meter;
    tracer?: Tracer;
  }>,
): ProviderOperationTelemetry<Output> {
  const meter =
    input.meter ?? metrics.getMeter(input.instrumentationName, '0.0.0');
  const tracer =
    input.tracer ?? trace.getTracer(input.instrumentationName, '0.0.0');
  const count = meter.createCounter('pertexo.provider.request.count', {
    description:
      'Completed provider requests by bounded provider/operation/outcome',
    unit: '{request}',
  });
  const duration = meter.createHistogram('pertexo.provider.request.duration', {
    description:
      'Provider request duration by bounded provider/operation/outcome',
    unit: 's',
  });
  const rateLimit = meter.createCounter('pertexo.provider.rate_limit.count', {
    description: 'Provider rate-limit outcomes by bounded provider/operation',
    unit: '{event}',
  });
  return Object.freeze({
    measure: (work: () => Promise<Output>) =>
      runProviderWorkOnceWithOptionalTrace<Output, Span>(
        async (span) => {
          const startedAt = monotonicNow();
          let attributes: Record<string, string | boolean> = {
            provider_key: input.providerKey,
            operation_key: input.operationKey,
            outcome: 'succeeded',
            possibly_dispatched: true,
          };
          try {
            return await work();
          } catch (error: unknown) {
            attributes = failureAttributes(input, error);
            throw error;
          } finally {
            recordDiagnostic(() => {
              count.add(1, attributes);
            });
            recordDiagnostic(() => {
              duration.record(
                Math.max(0, monotonicNow() - startedAt) / 1_000,
                attributes,
              );
            });
            if (attributes.error_class === 'rate_limit')
              recordDiagnostic(() => {
                rateLimit.add(1, attributes);
              });
            if (span !== undefined) {
              for (const [key, value] of Object.entries(attributes))
                recordDiagnostic(() => {
                  span.setAttribute(key, value);
                });
              recordDiagnostic(() => {
                span.setStatus({
                  code:
                    attributes.outcome === 'succeeded'
                      ? SpanStatusCode.OK
                      : SpanStatusCode.ERROR,
                });
              });
              recordDiagnostic(() => {
                span.end();
              });
            }
          }
        },
        (callback) => tracer.startActiveSpan(input.spanName, callback),
      ),
  });
}
