import {
  SpanStatusCode,
  type Meter,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { EmailSendNotificationExecutorError } from '@pertexo/integrations/server';
import { describe, expect, it, vi } from 'vitest';

import { createProductionEmailProviderTelemetry } from '../src/execution/email-provider-telemetry.js';

describe('email provider telemetry', () => {
  it('records only fixed-cardinality attributes and no email content', async () => {
    const counters = new Map<string, ReturnType<typeof vi.fn>>();
    const histograms = new Map<string, ReturnType<typeof vi.fn>>();
    const createCounter = vi.fn((name: string) => {
      const add = vi.fn();
      counters.set(name, add);
      return { add };
    });
    const createHistogram = vi.fn((name: string) => {
      const record = vi.fn();
      histograms.set(name, record);
      return { record };
    });
    const setAttribute = vi.fn();
    const setStatus = vi.fn();
    const span = { end: vi.fn(), setAttribute, setStatus } as unknown as Span;
    const telemetry = createProductionEmailProviderTelemetry({
      meter: { createCounter, createHistogram } as unknown as Meter,
      tracer: {
        startActiveSpan: (
          _name: string,
          work: (value: Span) => Promise<unknown>,
        ) => work(span),
      } as unknown as Tracer,
    });
    const output = { emailId: 'private-email-output-sentinel' };
    await expect(
      telemetry.measure(() => Promise.resolve(output)),
    ).resolves.toBe(output);
    const successAttributes = {
      provider_key: 'email',
      operation_key: 'send_notification',
      outcome: 'succeeded',
      possibly_dispatched: true,
    };
    expect(counters.get('pertexo.provider.request.count')).toHaveBeenCalledWith(
      1,
      successAttributes,
    );
    expect(
      counters.get('pertexo.provider.rate_limit.count'),
    ).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    const failure = new EmailSendNotificationExecutorError({
      kind: 'retry',
      errorKind: 'rate_limit',
      possiblyDispatched: true,
    });
    Object.assign(failure, { privateDetail: 'private-email-error-sentinel' });
    await expect(telemetry.measure(() => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    expect(
      counters.get('pertexo.provider.rate_limit.count'),
    ).toHaveBeenCalledOnce();
    expect(
      counters.get('pertexo.provider.rate_limit.count'),
    ).toHaveBeenCalledWith(1, {
      provider_key: 'email',
      operation_key: 'send_notification',
      outcome: 'retry',
      error_class: 'rate_limit',
      possibly_dispatched: true,
    });
    const surface = JSON.stringify({
      counters: [...counters.values()].map((counter) => counter.mock.calls),
      histograms: [...histograms.values()].map(
        (histogram) => histogram.mock.calls,
      ),
      span: setAttribute.mock.calls,
    });
    for (const forbidden of [
      'sender@example.com',
      'to@example.com',
      'subject',
      'text',
      're_secret',
      'private-email-output-sentinel',
      'private-email-error-sentinel',
    ])
      expect(surface).not.toContain(forbidden);
  });

  it('preserves ordinary and hostile rejection identity', async () => {
    const telemetry = createProductionEmailProviderTelemetry({
      meter: {
        createCounter: () => ({ add: vi.fn() }),
        createHistogram: () => ({ record: vi.fn() }),
      } as unknown as Meter,
      tracer: {
        startActiveSpan: (
          _name: string,
          work: (value: Span) => Promise<unknown>,
        ) =>
          work({
            end: vi.fn(),
            setAttribute: vi.fn(),
            setStatus: vi.fn(),
          } as unknown as Span),
      } as unknown as Tracer,
    });
    const ordinary = new Error('ordinary');
    await expect(
      telemetry.measure(() => Promise.reject(ordinary)),
    ).rejects.toBe(ordinary);
    const revoked = Proxy.revocable(new Error('hostile'), {});
    revoked.revoke();
    await expect(
      telemetry.measure(() => Promise.reject(revoked.proxy)),
    ).rejects.toBe(revoked.proxy);
  });
});
