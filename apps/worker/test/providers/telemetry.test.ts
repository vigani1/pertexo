import {
  SpanStatusCode,
  type Attributes,
  type Meter,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import {
  HttpRequestExecutorError,
  SlackSendMessageExecutorError,
} from '@pertexo/integrations/server';
import { describe, expect, it } from 'vitest';

import {
  createEmailProviderTelemetry,
  createHttpProviderTelemetry,
  createSlackProviderTelemetry,
} from '../../src/providers/telemetry.js';

function recorder() {
  const counts = new Map<string, Attributes[]>();
  const durations: Attributes[] = [];
  const spans: {
    name: string;
    attributes: Attributes;
    status?: SpanStatusCode;
    ended: boolean;
  }[] = [];
  const meter = {
    createCounter: (name: string) => ({
      add: (_value: number, attributes: Attributes) => {
        counts.set(name, [...(counts.get(name) ?? []), attributes]);
      },
    }),
    createHistogram: () => ({
      record: (_value: number, attributes: Attributes) => {
        durations.push(attributes);
      },
    }),
  } as unknown as Meter;
  const tracer = {
    startActiveSpan: (name: string, work: (span: Span) => unknown) => {
      const recorded: (typeof spans)[number] = {
        name,
        attributes: {},
        ended: false,
      };
      spans.push(recorded);
      return work({
        setAttributes: (values: Attributes) => {
          Object.assign(recorded.attributes, values);
        },
        setStatus: ({ code }: { code: SpanStatusCode }) => {
          recorded.status = code;
        },
        end: () => {
          recorded.ended = true;
        },
      } as unknown as Span);
    },
  } as unknown as Tracer;
  return { counts, durations, meter, spans, tracer };
}

describe('provider telemetry', () => {
  it('records a success with bounded attributes only', async () => {
    const recorded = recorder();
    const telemetry = createSlackProviderTelemetry(recorded);
    const output = {
      channelId: 'private-channel-sentinel',
      messageTs: 'private-message-sentinel',
    };

    await expect(
      telemetry.measure(() => Promise.resolve(output)),
    ).resolves.toBe(output);

    const success = {
      provider_key: 'slack',
      operation_key: 'send_message',
      outcome: 'succeeded',
      possibly_dispatched: true,
    };
    expect(recorded.counts.get('pertexo.provider.request.count')).toEqual([
      success,
    ]);
    expect(recorded.durations).toEqual([success]);
    expect(recorded.spans).toEqual([
      {
        name: 'pertexo.provider.slack.send_message',
        attributes: success,
        status: SpanStatusCode.OK,
        ended: true,
      },
    ]);
    expect(JSON.stringify(recorded)).not.toMatch(/sentinel/u);
  });

  it('adds the response storage to an HTTP success', async () => {
    const recorded = recorder();
    const output = { status: 200, body: { kind: 'inline' } } as never;

    await createHttpProviderTelemetry(recorded).measure(() =>
      Promise.resolve(output),
    );

    expect(recorded.spans[0]).toMatchObject({
      name: 'pertexo.provider.http.request',
      attributes: {
        provider_key: 'http',
        operation_key: 'request',
        outcome: 'succeeded',
        response_storage: 'inline',
        status_class: '2xx',
      },
    });
  });

  it('classifies a provider failure and counts rate limits', async () => {
    const recorded = recorder();
    const rateLimited = new SlackSendMessageExecutorError(
      { kind: 'retry', errorKind: 'rate_limit', possiblyDispatched: true },
      1_000,
    );
    Object.assign(rateLimited, { detail: 'private-error-sentinel' });

    await expect(
      createSlackProviderTelemetry(recorded).measure(() =>
        Promise.reject(rateLimited),
      ),
    ).rejects.toBe(rateLimited);

    const failure = {
      provider_key: 'slack',
      operation_key: 'send_message',
      outcome: 'retry',
      error_class: 'rate_limit',
      possibly_dispatched: true,
    };
    expect(recorded.counts.get('pertexo.provider.rate_limit.count')).toEqual([
      failure,
    ]);
    expect(recorded.spans[0]).toMatchObject({
      attributes: failure,
      status: SpanStatusCode.ERROR,
      ended: true,
    });
    expect(JSON.stringify(recorded)).not.toMatch(/sentinel/u);
  });

  it('reports an HTTP executor failure by its decision', async () => {
    const recorded = recorder();
    const failure = new HttpRequestExecutorError(
      { kind: 'failed', errorKind: 'provider' },
      true,
    );

    await expect(
      createHttpProviderTelemetry(recorded).measure(() =>
        Promise.reject(failure),
      ),
    ).rejects.toBe(failure);

    expect(recorded.spans[0]?.attributes).toEqual({
      provider_key: 'http',
      operation_key: 'request',
      outcome: 'failed',
      error_class: 'provider',
      possibly_dispatched: true,
    });
  });

  it('reports an unclassified error as an internal failure', async () => {
    const recorded = recorder();
    const error = new Error('unexpected');

    await expect(
      createEmailProviderTelemetry(recorded).measure(() =>
        Promise.reject(error),
      ),
    ).rejects.toBe(error);

    expect(recorded.counts.get('pertexo.provider.request.count')).toEqual([
      {
        provider_key: 'email',
        operation_key: 'send_notification',
        outcome: 'failed',
        error_class: 'internal',
        possibly_dispatched: false,
      },
    ]);
    expect(recorded.counts.get('pertexo.provider.rate_limit.count')).toBe(
      undefined,
    );
  });
});
