import {
  SpanStatusCode,
  type Meter,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { SlackSendMessageExecutorError } from '@pertexo/integrations/server';
import { describe, expect, it, vi } from 'vitest';

import { createProductionSlackProviderTelemetry } from '../src/execution/slack-provider-telemetry.js';

describe('Slack provider telemetry', () => {
  it('records only bounded success and rate-limit attributes', async () => {
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
    const end = vi.fn();
    const span = { end, setAttribute, setStatus } as unknown as Span;
    const startActiveSpan = vi.fn(
      (_name: string, work: (activeSpan: Span) => Promise<unknown>) =>
        work(span),
    );
    const telemetry = createProductionSlackProviderTelemetry({
      meter: { createCounter, createHistogram } as unknown as Meter,
      tracer: { startActiveSpan } as unknown as Tracer,
    });
    const output = {
      channelId: 'private-channel-sentinel',
      messageTs: 'private-message-sentinel',
    };

    await expect(
      telemetry.measure(() => Promise.resolve(output)),
    ).resolves.toBe(output);
    const successAttributes = {
      provider_key: 'slack',
      operation_key: 'send_message',
      outcome: 'succeeded',
      possibly_dispatched: true,
    };
    expect(counters.get('pertexo.provider.request.count')).toHaveBeenCalledWith(
      1,
      successAttributes,
    );
    expect(
      histograms.get('pertexo.provider.request.duration'),
    ).toHaveBeenCalledWith(expect.any(Number), successAttributes);
    expect(startActiveSpan).toHaveBeenCalledWith(
      'pertexo.provider.slack.send_message',
      expect.any(Function),
    );
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });

    const rateLimited = new SlackSendMessageExecutorError(
      {
        kind: 'retry',
        errorKind: 'rate_limit',
        possiblyDispatched: true,
      },
      1_000,
    );
    Object.assign(rateLimited, { privateDetail: 'private-error-sentinel' });
    await expect(
      telemetry.measure(() => Promise.reject(rateLimited)),
    ).rejects.toBe(rateLimited);
    expect(
      counters.get('pertexo.provider.rate_limit.count'),
    ).toHaveBeenCalledWith(1, {
      provider_key: 'slack',
      operation_key: 'send_message',
      outcome: 'retry',
      error_class: 'rate_limit',
      possibly_dispatched: true,
    });
    expect(end).toHaveBeenCalledTimes(2);
    expect(
      JSON.stringify({
        counters: [...counters.values()].map((counter) => counter.mock.calls),
        histograms: [...histograms.values()].map(
          (histogram) => histogram.mock.calls,
        ),
        span: setAttribute.mock.calls,
      }),
    ).not.toMatch(
      /private-channel-sentinel|private-message-sentinel|private-error-sentinel/u,
    );
  });

  it('does not change provider truth when diagnostics throw', async () => {
    const startActiveSpan = vi.fn(
      (_name: string, work: (activeSpan: Span) => Promise<unknown>) =>
        work({
          setAttribute: () => {
            throw new Error('telemetry unavailable');
          },
          setStatus: () => {
            throw new Error('telemetry unavailable');
          },
          end: () => void 0,
        } as unknown as Span),
    );
    const telemetry = createProductionSlackProviderTelemetry({
      meter: {
        createCounter: () => ({ add: () => void 0 }),
        createHistogram: () => ({ record: () => void 0 }),
      } as unknown as Meter,
      tracer: { startActiveSpan } as unknown as Tracer,
    });
    const output = {
      channelId: 'C123ABC',
      messageTs: '1724412345.000100',
    };

    await expect(
      telemetry.measure(() => Promise.resolve(output)),
    ).resolves.toBe(output);
  });

  it('preserves ordinary and hostile rejection identity', async () => {
    const telemetry = createProductionSlackProviderTelemetry({
      meter: {
        createCounter: () => ({ add: vi.fn() }),
        createHistogram: () => ({ record: vi.fn() }),
      } as unknown as Meter,
      tracer: {
        startActiveSpan: (
          _name: string,
          work: (activeSpan: Span) => Promise<unknown>,
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
