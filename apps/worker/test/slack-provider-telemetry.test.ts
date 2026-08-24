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
      channelId: 'C123ABC',
      messageTs: '1724412345.000100',
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
    expect(Object.keys(successAttributes)).not.toEqual(
      expect.arrayContaining([
        'bot_token',
        'channel_id',
        'connection_id',
        'message_ts',
        'text',
      ]),
    );

    const rateLimited = new SlackSendMessageExecutorError(
      {
        kind: 'retry',
        errorKind: 'rate_limit',
        possiblyDispatched: true,
      },
      1_000,
    );
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
});
