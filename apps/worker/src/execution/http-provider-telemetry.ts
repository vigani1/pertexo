import {
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type Meter,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import {
  HttpRequestExecutorError,
  type HttpExecutionErrorKind,
  type HttpRequestExecutorTelemetry,
} from '@pertexo/integrations/server';

export type HttpProviderRequestMeasurement = Readonly<{
  providerKey: 'http';
  operationKey: 'request';
  outcome: 'succeeded' | 'failed' | 'canceled' | 'retry' | 'outcome_unknown';
  possiblyDispatched: boolean;
  errorClass?: HttpExecutionErrorKind | 'internal';
  responseStorage?: 'inline' | 'artifact';
  statusClass?: '2xx';
}>;

export type HttpProviderTelemetryOptions = Readonly<{
  annotate?(measurement: HttpProviderRequestMeasurement): void;
  count(measurement: HttpProviderRequestMeasurement): void;
  duration(measurement: HttpProviderRequestMeasurement, seconds: number): void;
  rateLimit(measurement: HttpProviderRequestMeasurement): void;
  trace<T>(work: () => Promise<T>): Promise<T>;
  monotonicNow?: () => number;
}>;

export function createHttpProviderTelemetry(
  options: HttpProviderTelemetryOptions,
): HttpRequestExecutorTelemetry {
  const now = options.monotonicNow ?? (() => performance.now());
  return Object.freeze({
    measure: (work: Parameters<HttpRequestExecutorTelemetry['measure']>[0]) => {
      const measured = async () => {
        const startedAt = safeNow(now);
        try {
          const output = await work();
          record(
            Object.freeze({
              providerKey: 'http' as const,
              operationKey: 'request' as const,
              outcome: 'succeeded' as const,
              possiblyDispatched: true,
              responseStorage: output.body.kind,
              statusClass: '2xx' as const,
            }),
            startedAt,
          );
          return output;
        } catch (error: unknown) {
          record(failureMeasurement(error), startedAt);
          throw error;
        }
      };
      try {
        return options.trace(measured);
      } catch {
        return measured();
      }
    },
  });

  function record(
    measurement: HttpProviderRequestMeasurement,
    startedAt: number,
  ): void {
    try {
      options.count(measurement);
      options.annotate?.(measurement);
      options.duration(
        measurement,
        Math.max(0, safeNow(now) - startedAt) / 1_000,
      );
      if (measurement.errorClass === 'rate_limit')
        options.rateLimit(measurement);
    } catch {
      // Diagnostics cannot change provider execution truth.
    }
  }
}

function failureMeasurement(error: unknown): HttpProviderRequestMeasurement {
  if (error instanceof HttpRequestExecutorError)
    return Object.freeze({
      providerKey: 'http',
      operationKey: 'request',
      outcome: error.decision.kind,
      possiblyDispatched: error.possiblyDispatched,
      ...(error.decision.kind === 'succeeded'
        ? {}
        : { errorClass: error.decision.errorKind }),
    });
  return Object.freeze({
    providerKey: 'http',
    operationKey: 'request',
    outcome: 'failed',
    possiblyDispatched: false,
    errorClass: 'internal',
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

function attributes(measurement: HttpProviderRequestMeasurement): Attributes {
  return {
    provider_key: measurement.providerKey,
    operation_key: measurement.operationKey,
    outcome: measurement.outcome,
    possibly_dispatched: measurement.possiblyDispatched,
    ...(measurement.errorClass === undefined
      ? {}
      : { error_class: measurement.errorClass }),
    ...(measurement.responseStorage === undefined
      ? {}
      : { response_storage: measurement.responseStorage }),
    ...(measurement.statusClass === undefined
      ? {}
      : { status_class: measurement.statusClass }),
  };
}

export type ProductionHttpProviderTelemetryOptions = Readonly<{
  meter?: Meter;
  tracer?: Tracer;
}>;

export function createProductionHttpProviderTelemetry(
  options: ProductionHttpProviderTelemetryOptions = {},
): HttpRequestExecutorTelemetry {
  const meter =
    options.meter ?? metrics.getMeter('@pertexo/worker.provider-http', '0.0.0');
  const tracer =
    options.tracer ?? trace.getTracer('@pertexo/worker.provider-http', '0.0.0');
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
    measure: (work: Parameters<HttpRequestExecutorTelemetry['measure']>[0]) =>
      tracer.startActiveSpan('pertexo.provider.http.request', async (span) => {
        const measured = createHttpProviderTelemetry({
          annotate: (measurement) => {
            annotateSpan(span, measurement);
          },
          count: (measurement) => {
            count.add(1, attributes(measurement));
          },
          duration: (measurement, seconds) => {
            duration.record(seconds, attributes(measurement));
          },
          rateLimit: (measurement) => {
            rateLimit.add(1, attributes(measurement));
          },
          trace: (innerWork) => innerWork(),
        });
        try {
          return await measured.measure(work);
        } finally {
          span.end();
        }
      }),
  });
}

function annotateSpan(
  span: Span,
  measurement: HttpProviderRequestMeasurement,
): void {
  const values = attributes(measurement);
  for (const [name, value] of Object.entries(values))
    if (value !== undefined) span.setAttribute(name, value);
  span.setStatus({
    code:
      measurement.outcome === 'succeeded'
        ? SpanStatusCode.OK
        : SpanStatusCode.ERROR,
  });
}
