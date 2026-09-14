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
      let workPromise: Promise<T> | undefined;
      let owningSpan: Span | undefined;
      const runOnce = (span?: Span): Promise<T> => {
        if (workPromise === undefined) {
          owningSpan = span;
          workPromise = Promise.resolve()
            .then(work)
            .catch((error: unknown) => {
              safeSpanOperation(() => {
                span?.setStatus({ code: SpanStatusCode.ERROR });
              });
              throw error;
            })
            .finally(() => {
              safeSpanOperation(() => {
                span?.end();
              });
            });
        } else if (span !== undefined && span !== owningSpan) {
          safeSpanOperation(() => {
            span.end();
          });
        }
        return workPromise;
      };
      let tracePromise: Promise<T> | undefined;
      try {
        tracePromise = tracer.startActiveSpan(
          'webhook.ingress',
          {},
          parent,
          (span) => runOnce(span),
        );
      } catch {
        return runOnce();
      }
      void Promise.resolve(tracePromise).catch(() => undefined);
      return workPromise ?? runOnce();
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

function safeSpanOperation(operation: () => void): void {
  try {
    operation();
  } catch {
    // Diagnostics cannot change webhook acceptance truth.
  }
}
