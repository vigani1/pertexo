import {
  metrics,
  SpanStatusCode,
  trace,
  type Meter,
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
      tracer.startActiveSpan(input.spanName, async (span) => {
        const startedAt = performance.now();
        let attributes: Record<string, string | boolean> = {
          provider_key: input.providerKey,
          operation_key: input.operationKey,
          outcome: 'succeeded',
          possibly_dispatched: true,
        };
        try {
          return await work();
        } catch (error: unknown) {
          const failure = input.classifyFailure(error);
          attributes = {
            provider_key: input.providerKey,
            operation_key: input.operationKey,
            outcome: failure?.outcome ?? 'failed',
            error_class: failure?.errorClass ?? 'internal',
            possibly_dispatched: failure?.possiblyDispatched ?? false,
          };
          throw error;
        } finally {
          try {
            count.add(1, attributes);
            duration.record(
              Math.max(0, performance.now() - startedAt) / 1_000,
              attributes,
            );
            if (attributes.error_class === 'rate_limit')
              rateLimit.add(1, attributes);
            for (const [key, value] of Object.entries(attributes))
              span.setAttribute(key, value);
            span.setStatus({
              code:
                attributes.outcome === 'succeeded'
                  ? SpanStatusCode.OK
                  : SpanStatusCode.ERROR,
            });
          } catch {
            // Diagnostics cannot change provider execution truth.
          }
          span.end();
        }
      }),
  });
}
