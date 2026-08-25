import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u;

export type WebhookDeliveryOutcome =
  | 'accepted'
  | 'replayed'
  | 'authentication_failed'
  | 'invalid_request'
  | 'rate_limited'
  | 'conflict'
  | 'unavailable';

export interface WebhookIngressTelemetry {
  delivery(outcome: WebhookDeliveryOutcome): void;
  deduplication(outcome: 'new' | 'replayed' | 'conflict'): void;
  health(status: 'healthy' | 'degraded'): void;
  traceparent(): string | undefined;
  trace<T>(traceparent: string | undefined, work: () => Promise<T>): Promise<T>;
}

export function createWebhookIngressTelemetry(): WebhookIngressTelemetry {
  const meter = metrics.getMeter('@pertexo/api.webhooks', '0.0.0');
  const delivery = meter.createCounter('pertexo.webhook.delivery.count', {
    description: 'Webhook deliveries by bounded outcome',
  });
  const deduplication = meter.createCounter(
    'pertexo.webhook.deduplication.count',
    { description: 'Webhook deduplication decisions by bounded outcome' },
  );
  const health = meter.createCounter('pertexo.webhook.health.count', {
    description: 'Webhook ingress health observations by bounded status',
  });
  const tracer = trace.getTracer('@pertexo/api.webhooks', '0.0.0');
  const telemetry: WebhookIngressTelemetry = {
    delivery: (outcome: WebhookDeliveryOutcome) => {
      delivery.add(1, { outcome });
    },
    deduplication: (outcome: 'new' | 'replayed' | 'conflict') => {
      deduplication.add(1, { outcome });
    },
    health: (status: 'healthy' | 'degraded') => {
      health.add(1, { status });
    },
    traceparent: () => {
      const spanContext = trace.getActiveSpan()?.spanContext();
      if (spanContext === undefined) return undefined;
      return `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags.toString(16).padStart(2, '0')}`;
    },
    trace: <T>(traceparent: string | undefined, work: () => Promise<T>) => {
      const match = traceparent?.match(TRACEPARENT);
      const parent =
        match === undefined || match === null
          ? context.active()
          : trace.setSpanContext(context.active(), {
              traceId: match[1] ?? '',
              spanId: match[2] ?? '',
              traceFlags: Number.parseInt(match[3] ?? '00', 16),
              isRemote: true,
            });
      return tracer.startActiveSpan(
        'webhook.ingress',
        {},
        parent,
        async (span) => {
          try {
            return await work();
          } catch (error: unknown) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            span.end();
          }
        },
      );
    },
  };
  return Object.freeze(telemetry);
}
