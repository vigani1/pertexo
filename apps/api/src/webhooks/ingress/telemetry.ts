import { measureOperation } from '@pertexo/observability';
import {
  context,
  metrics,
  SpanStatusCode,
  trace,
  type Span,
} from '@opentelemetry/api';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u;

export type WebhookDeliveryOutcome =
  | 'accepted'
  | 'skipped'
  | 'replayed'
  | 'authentication_failed'
  | 'invalid_request'
  | 'rate_limited'
  | 'paused'
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
  try {
    return createConfiguredWebhookIngressTelemetry();
  } catch {
    return NOOP_WEBHOOK_INGRESS_TELEMETRY;
  }
}

function createConfiguredWebhookIngressTelemetry(): WebhookIngressTelemetry {
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
      const candidate =
        match === undefined || match === null
          ? undefined
          : {
              traceId: match[1] ?? '',
              spanId: match[2] ?? '',
              traceFlags: Number.parseInt(match[3] ?? '00', 16),
              isRemote: true,
            };
      const parent =
        candidate === undefined || !trace.isSpanContextValid(candidate)
          ? context.active()
          : trace.setSpanContext(context.active(), candidate);
      return measureOperation<T, Span>({
        work: () => Promise.resolve().then(work),
        trace: (run) =>
          tracer.startActiveSpan('webhook.ingress', {}, parent, run),
        record: ({ outcome, span }) => {
          if (outcome === 'failed')
            span?.setStatus({ code: SpanStatusCode.ERROR });
        },
      });
    },
  };
  return Object.freeze(telemetry);
}

const NOOP_WEBHOOK_INGRESS_TELEMETRY: WebhookIngressTelemetry = Object.freeze({
  delivery: () => undefined,
  deduplication: () => undefined,
  health: () => undefined,
  traceparent: () => undefined,
  trace: <T>(_traceparent: string | undefined, work: () => Promise<T>) =>
    work(),
});
