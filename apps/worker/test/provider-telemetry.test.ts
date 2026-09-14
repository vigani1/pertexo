import {
  SpanStatusCode,
  type Meter,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import { createProductionProviderTelemetry } from '../src/execution/provider-telemetry.js';

type DiagnosticStage =
  | 'start_before_callback'
  | 'start_before_callback_async'
  | 'trace_after_callback_sync'
  | 'trace_after_callback_async'
  | 'count'
  | 'rate_limit'
  | 'duration'
  | 'attribute'
  | 'status'
  | 'end';

function diagnostics(stage?: DiagnosticStage) {
  const counters = new Map<string, ReturnType<typeof vi.fn>>();
  const histograms = new Map<string, ReturnType<typeof vi.fn>>();
  const createCounter = vi.fn((name: string) => {
    const add = vi.fn(() => {
      if (stage === 'count' && name === 'pertexo.provider.request.count')
        throw new Error('count failed');
      if (
        stage === 'rate_limit' &&
        name === 'pertexo.provider.rate_limit.count'
      )
        throw new Error('rate-limit count failed');
    });
    counters.set(name, add);
    return { add };
  });
  const createHistogram = vi.fn((name: string) => {
    const record = vi.fn(() => {
      if (stage === 'duration') throw new Error('duration failed');
    });
    histograms.set(name, record);
    return { record };
  });
  const setAttribute = vi.fn(() => {
    if (stage === 'attribute') throw new Error('attribute failed');
  });
  const setStatus = vi.fn(() => {
    if (stage === 'status') throw new Error('status failed');
  });
  const end = vi.fn(() => {
    if (stage === 'end') throw new Error('end failed');
  });
  const span = { end, setAttribute, setStatus } as unknown as Span;
  const startActiveSpan = vi.fn(
    (_name: string, callback: (activeSpan: Span) => Promise<unknown>) => {
      if (stage === 'start_before_callback')
        throw new Error('span start failed');
      if (stage === 'start_before_callback_async')
        return Promise.reject(new Error('async span start failed'));
      const work = callback(span);
      if (stage === 'trace_after_callback_sync')
        throw new Error('trace wrapper failed');
      if (stage === 'trace_after_callback_async')
        return Promise.reject(new Error('async trace wrapper failed'));
      return work;
    },
  );
  return {
    counters,
    end,
    histograms,
    meter: { createCounter, createHistogram } as unknown as Meter,
    setAttribute,
    setStatus,
    startActiveSpan,
    tracer: { startActiveSpan } as unknown as Tracer,
  };
}

function telemetry(stage?: DiagnosticStage) {
  const harness = diagnostics(stage);
  return {
    harness,
    telemetry: createProductionProviderTelemetry<{
      messageId: string;
      privatePayload: string;
    }>({
      instrumentationName: '@pertexo/test.provider',
      spanName: 'pertexo.provider.test.send',
      providerKey: 'test',
      operationKey: 'send',
      classifyFailure: (error) => {
        if (!(error instanceof Error)) return undefined;
        return {
          errorClass: 'rate_limit',
          outcome: 'retry',
          possiblyDispatched: true,
        };
      },
      meter: harness.meter,
      tracer: harness.tracer,
    }),
  };
}

describe('shared provider telemetry', () => {
  it.each([
    'start_before_callback',
    'start_before_callback_async',
    'trace_after_callback_sync',
    'trace_after_callback_async',
    'count',
    'duration',
    'attribute',
    'status',
    'end',
  ] as const)(
    'preserves one successful operation when %s fails',
    async (stage) => {
      const { harness, telemetry: measured } = telemetry(stage);
      const output = {
        messageId: 'provider-result',
        privatePayload: 'private-output-sentinel',
      };
      const work = vi.fn(() => Promise.resolve(output));

      await expect(measured.measure(work)).resolves.toBe(output);
      expect(work).toHaveBeenCalledOnce();
      if (
        stage !== 'start_before_callback' &&
        stage !== 'start_before_callback_async'
      ) {
        expect(harness.end).toHaveBeenCalledOnce();
        expect(harness.setStatus).toHaveBeenCalledWith({
          code: SpanStatusCode.OK,
        });
      }
    },
  );

  it.each([
    'start_before_callback',
    'start_before_callback_async',
    'trace_after_callback_sync',
    'trace_after_callback_async',
    'count',
    'rate_limit',
    'duration',
    'attribute',
    'status',
    'end',
  ] as const)(
    'preserves one rejected operation when %s fails',
    async (stage) => {
      const { telemetry: measured } = telemetry(stage);
      const failure = new Error('original provider failure');
      const work = vi.fn(() => Promise.reject(failure));

      await expect(measured.measure(work)).rejects.toBe(failure);
      expect(work).toHaveBeenCalledOnce();
    },
  );

  it('preserves the exact typed rejection and bounded failure attributes', async () => {
    const { harness, telemetry: measured } = telemetry();
    const failure = new Error('private-error-sentinel');
    const work = vi.fn(() => Promise.reject(failure));

    await expect(measured.measure(work)).rejects.toBe(failure);
    expect(work).toHaveBeenCalledOnce();
    const expected = {
      provider_key: 'test',
      operation_key: 'send',
      outcome: 'retry',
      error_class: 'rate_limit',
      possibly_dispatched: true,
    };
    expect(
      harness.counters.get('pertexo.provider.request.count'),
    ).toHaveBeenCalledWith(1, expected);
    expect(
      harness.counters.get('pertexo.provider.rate_limit.count'),
    ).toHaveBeenCalledWith(1, expected);
    expect(harness.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
    });
    const diagnosticsSurface = JSON.stringify({
      counters: [...harness.counters.values()].map((call) => call.mock.calls),
      histograms: [...harness.histograms.values()].map(
        (call) => call.mock.calls,
      ),
      span: harness.setAttribute.mock.calls,
    });
    expect(diagnosticsSurface).not.toContain('private-error-sentinel');
    expect(diagnosticsSurface).not.toContain('private-output-sentinel');
  });

  it('contains classifier failure for a hostile rejection and preserves identity', async () => {
    const { telemetry: measured } = telemetry();
    const revoked = Proxy.revocable(new Error('private-hostile-sentinel'), {});
    revoked.revoke();
    const work = vi.fn(() => Promise.reject(revoked.proxy));

    await expect(measured.measure(work)).rejects.toBe(revoked.proxy);
    expect(work).toHaveBeenCalledOnce();
  });
});
