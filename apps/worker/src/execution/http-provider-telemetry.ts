import {
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type Meter,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import type { HttpRequestOutput } from '@pertexo/integrations';
import {
  HttpRequestExecutorError,
  type HttpExecutionErrorKind,
  type HttpRequestExecutorTelemetry,
} from '@pertexo/integrations/server';
import { runProviderWorkOnceWithOptionalTrace } from './provider-telemetry.js';

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
      const measured = async (): ReturnType<
        HttpRequestExecutorTelemetry['measure']
      > => {
        const startedAt = safeNow(now);
        try {
          const output = await work();
          record(successMeasurement(output), startedAt);
          return output;
        } catch (error: unknown) {
          record(failureMeasurement(error), startedAt);
          throw error;
        }
      };
      return runProviderWorkOnceWithOptionalTrace<HttpRequestOutput, undefined>(
        () => measured(),
        (callback) => options.trace(() => callback(undefined)),
      );
    },
  });

  function record(
    measurement: HttpProviderRequestMeasurement,
    startedAt: number,
  ): void {
    recordDiagnostic(() => {
      options.count(measurement);
    });
    recordDiagnostic(() => {
      options.annotate?.(measurement);
    });
    recordDiagnostic(() => {
      options.duration(
        measurement,
        Math.max(0, safeNow(now) - startedAt) / 1_000,
      );
    });
    if (measurement.errorClass === 'rate_limit')
      recordDiagnostic(() => {
        options.rateLimit(measurement);
      });
  }
}

function recordDiagnostic(operation: () => void): void {
  try {
    operation();
  } catch {
    // Diagnostics cannot change provider execution truth.
  }
}

function successMeasurement(
  output: Awaited<
    ReturnType<Parameters<HttpRequestExecutorTelemetry['measure']>[0]>
  >,
): HttpProviderRequestMeasurement {
  try {
    return Object.freeze({
      providerKey: 'http',
      operationKey: 'request',
      outcome: 'succeeded',
      possiblyDispatched: true,
      responseStorage: output.body.kind,
      statusClass: '2xx',
    });
  } catch {
    return Object.freeze({
      providerKey: 'http',
      operationKey: 'request',
      outcome: 'succeeded',
      possiblyDispatched: true,
    });
  }
}

function failureMeasurement(error: unknown): HttpProviderRequestMeasurement {
  try {
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
  } catch {
    // Hostile rejections cannot supply trusted HTTP outcome metadata.
  }
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
      runProviderWorkOnceWithOptionalTrace<HttpRequestOutput, Span>(
        async (span) => {
          const measured = createHttpProviderTelemetry({
            ...(span === undefined
              ? {}
              : {
                  annotate: (measurement) => {
                    annotateSpan(span, measurement);
                  },
                }),
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
            if (span !== undefined)
              recordDiagnostic(() => {
                span.end();
              });
          }
        },
        (callback) =>
          tracer.startActiveSpan('pertexo.provider.http.request', callback),
      ),
  });
}

function annotateSpan(
  span: Span,
  measurement: HttpProviderRequestMeasurement,
): void {
  const values = attributes(measurement);
  for (const [name, value] of Object.entries(values))
    if (value !== undefined)
      recordDiagnostic(() => {
        span.setAttribute(name, value);
      });
  recordDiagnostic(() => {
    span.setStatus({
      code:
        measurement.outcome === 'succeeded'
          ? SpanStatusCode.OK
          : SpanStatusCode.ERROR,
    });
  });
}
