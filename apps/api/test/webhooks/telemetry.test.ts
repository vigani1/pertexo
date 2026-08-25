import { NodeSDK } from '@opentelemetry/sdk-node';
import { describe, expect, it } from 'vitest';

import { createWebhookIngressTelemetry } from '../../src/webhooks/telemetry.js';

describe('webhook ingress telemetry', () => {
  it('continues a remote parent and exposes the child context for persistence', async () => {
    const spans: ExportedSpan[] = [];
    const sdk = new NodeSDK({
      instrumentations: [],
      traceExporter: {
        export(batch, callback) {
          spans.push(...(batch as ExportedSpan[]));
          callback({ code: 0 });
        },
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
    });
    sdk.start();
    const telemetry = createWebhookIngressTelemetry();
    const parentTraceId = 'a'.repeat(32);
    const parentSpanId = 'b'.repeat(16);
    let persistedTraceparent: string | undefined;

    try {
      await telemetry.trace(`00-${parentTraceId}-${parentSpanId}-01`, () => {
        persistedTraceparent = telemetry.traceparent();
        return Promise.resolve();
      });
    } finally {
      await sdk.shutdown();
    }

    const span = spans.find(({ name }) => name === 'webhook.ingress');
    if (span === undefined)
      throw new Error('Webhook ingress span was not exported');
    expect(span.parentSpanContext).toMatchObject({
      isRemote: true,
      spanId: parentSpanId,
      traceId: parentTraceId,
    });
    expect(persistedTraceparent).toBe(
      `00-${parentTraceId}-${span.spanContext().spanId}-01`,
    );
  });
});

interface ExportedSpan {
  readonly name: string;
  readonly parentSpanContext?: Readonly<{
    isRemote?: boolean;
    spanId: string;
    traceId: string;
  }>;
  spanContext(): Readonly<{ spanId: string }>;
}
