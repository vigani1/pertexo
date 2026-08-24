import {
  metrics,
  SpanStatusCode,
  trace,
  type Meter,
  type Tracer,
} from '@opentelemetry/api';
import {
  SlackSendMessageExecutorError,
  type SlackSendMessageExecutorTelemetry,
} from '@pertexo/integrations/server';
import type { SlackSendMessageOutput } from '@pertexo/integrations';

export function createProductionSlackProviderTelemetry(
  options: Readonly<{ meter?: Meter; tracer?: Tracer }> = {},
): SlackSendMessageExecutorTelemetry {
  const meter =
    options.meter ??
    metrics.getMeter('@pertexo/worker.provider-slack', '0.0.0');
  const tracer =
    options.tracer ??
    trace.getTracer('@pertexo/worker.provider-slack', '0.0.0');
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
    measure: (work: () => Promise<SlackSendMessageOutput>) =>
      tracer.startActiveSpan(
        'pertexo.provider.slack.send_message',
        async (span) => {
          const startedAt = performance.now();
          let attributes: Record<string, string | boolean> = {
            provider_key: 'slack',
            operation_key: 'send_message',
            outcome: 'succeeded',
            possibly_dispatched: true,
          };
          try {
            return await work();
          } catch (error: unknown) {
            attributes =
              error instanceof SlackSendMessageExecutorError
                ? {
                    provider_key: 'slack',
                    operation_key: 'send_message',
                    outcome: error.kind,
                    error_class: error.errorKind,
                    possibly_dispatched: error.possiblyDispatched,
                  }
                : {
                    provider_key: 'slack',
                    operation_key: 'send_message',
                    outcome: 'failed',
                    error_class: 'internal',
                    possibly_dispatched: false,
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
        },
      ),
  });
}
