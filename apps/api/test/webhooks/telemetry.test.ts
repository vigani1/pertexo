import { metrics, SpanStatusCode } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebhookIngressTelemetry } from '../../src/webhooks/ingress/telemetry.js';
import {
  startTelemetrySdk,
  type TelemetrySdk,
} from '../support/telemetry-sdk.js';

/**
 * A delivery that continues its sender's trace runs through the HTTP API in
 * direct-webhook.integration.test.ts; a broken tracer in
 * @pertexo/observability's measurement test. These cases use the real
 * OpenTelemetry SDK, except the first: the SDK never refuses to create an
 * instrument on demand, so that one replaces the outside library's meter.
 */
describe('webhook ingress telemetry', () => {
  let sdk: TelemetrySdk | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await sdk?.stop();
    sdk = undefined;
  });

  it('falls back to no-op diagnostics when instruments cannot be created', async () => {
    vi.spyOn(metrics, 'getMeter').mockImplementation(() => {
      throw new Error('meter unavailable');
    });
    const telemetry = createWebhookIngressTelemetry();

    await expect(
      telemetry.trace(undefined, () => Promise.resolve('accepted')),
    ).resolves.toBe('accepted');
    expect(telemetry.traceparent()).toBeUndefined();
    expect(() => {
      telemetry.delivery('accepted');
    }).not.toThrow();
  });

  it.each([
    '00-00000000000000000000000000000000-bbbbbbbbbbbbbbbb-01',
    '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000000-01',
    'not-a-traceparent',
    undefined,
  ])(
    'starts a new trace for the invalid or absent parent %s',
    async (parent) => {
      sdk = startTelemetrySdk();
      const telemetry = createWebhookIngressTelemetry();

      await telemetry.trace(parent, () => Promise.resolve());

      const [span] = sdk.spans();
      expect(span?.name).toBe('webhook.ingress');
      expect(span?.parentSpanContext).toBeUndefined();
    },
  );

  it('exposes the child of a remote parent inside its trace', async () => {
    sdk = startTelemetrySdk();
    const telemetry = createWebhookIngressTelemetry();
    const parent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;

    const inside = await telemetry.trace(parent, () =>
      Promise.resolve(telemetry.traceparent()),
    );

    const [span] = sdk.spans();
    expect(span?.parentSpanContext).toMatchObject({
      isRemote: true,
      spanId: 'b'.repeat(16),
      traceId: 'a'.repeat(32),
    });
    expect(inside).toBe(
      `00-${'a'.repeat(32)}-${String(span?.spanContext().spanId)}-01`,
    );
  });

  it('marks the span failed and keeps the failure when acceptance fails', async () => {
    sdk = startTelemetrySdk();
    const telemetry = createWebhookIngressTelemetry();
    const failure = new Error('acceptance failed');

    await expect(
      telemetry.trace(undefined, () => Promise.reject(failure)),
    ).rejects.toBe(failure);

    expect(sdk.spans().map(({ name, status }) => [name, status])).toEqual([
      ['webhook.ingress', { code: SpanStatusCode.ERROR }],
    ]);
  });
});
