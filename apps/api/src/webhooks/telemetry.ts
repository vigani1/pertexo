import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';

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
  trace<T>(work: () => Promise<T>): Promise<T>;
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
    trace: <T>(work: () => Promise<T>) =>
      tracer.startActiveSpan('webhook.ingress', async (span) => {
        try {
          return await work();
        } catch (error: unknown) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      }),
  };
  return Object.freeze(telemetry);
}
