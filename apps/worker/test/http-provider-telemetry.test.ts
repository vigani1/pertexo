import {
  SpanStatusCode,
  type Meter,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { HttpRequestExecutorError } from '@pertexo/integrations/server';
import { describe, expect, it, vi } from 'vitest';

import {
  createHttpProviderTelemetry,
  createProductionHttpProviderTelemetry,
  type HttpProviderRequestMeasurement,
} from '../src/execution/http-provider-telemetry.js';

const artifactOutput = Object.freeze({
  status: 200,
  headers: Object.freeze({ 'content-type': 'application/octet-stream' }),
  body: Object.freeze({
    kind: 'artifact' as const,
    artifactId: '11111111-1111-4111-8111-111111111111',
    byteLength: 70_000,
    mediaType: 'application/octet-stream',
    sha256: 'a'.repeat(64),
  }),
  finalOrigin: 'https://provider.example.test',
  redirectCount: 0,
});

describe('HTTP provider telemetry', () => {
  it('records bounded success, failure, duration, and rate-limit signals', async () => {
    const measurements: HttpProviderRequestMeasurement[] = [];
    const durations: number[] = [];
    const rateLimit = vi.fn();
    let traceCalls = 0;
    const trace = <T>(work: () => Promise<T>): Promise<T> => {
      traceCalls += 1;
      return work();
    };
    let now = 1_000;
    const telemetry = createHttpProviderTelemetry({
      count: (measurement) => measurements.push(measurement),
      duration: (_measurement, seconds) => durations.push(seconds),
      rateLimit,
      trace,
      monotonicNow: () => (now += 250),
    });

    await expect(
      telemetry.measure(() => Promise.resolve(artifactOutput)),
    ).resolves.toBe(artifactOutput);
    const failure = new HttpRequestExecutorError(
      Object.freeze({ kind: 'failed', errorKind: 'rate_limit' }),
      true,
    );
    await expect(telemetry.measure(() => Promise.reject(failure))).rejects.toBe(
      failure,
    );

    expect(measurements).toEqual([
      {
        providerKey: 'http',
        operationKey: 'request',
        outcome: 'succeeded',
        possiblyDispatched: true,
        responseStorage: 'artifact',
        statusClass: '2xx',
      },
      {
        providerKey: 'http',
        operationKey: 'request',
        outcome: 'failed',
        possiblyDispatched: true,
        errorClass: 'rate_limit',
      },
    ]);
    expect(durations).toEqual([0.25, 0.25]);
    expect(rateLimit).toHaveBeenCalledOnce();
    expect(rateLimit).toHaveBeenCalledWith(measurements[1]);
    expect(traceCalls).toBe(2);
  });

  it('classifies inline response storage without inspecting its value', async () => {
    const count = vi.fn();
    const telemetry = createHttpProviderTelemetry({
      count,
      duration: vi.fn(),
      rateLimit: vi.fn(),
      trace: (work) => work(),
    });
    const output = {
      ...artifactOutput,
      body: {
        kind: 'inline' as const,
        encoding: 'utf8' as const,
        value: 'private-inline-body-sentinel',
        byteLength: 28,
      },
    };

    await expect(
      telemetry.measure(() => Promise.resolve(output)),
    ).resolves.toBe(output);
    expect(count).toHaveBeenCalledWith({
      providerKey: 'http',
      operationKey: 'request',
      outcome: 'succeeded',
      possiblyDispatched: true,
      responseStorage: 'inline',
      statusClass: '2xx',
    });
    expect(JSON.stringify(count.mock.calls)).not.toContain(
      'private-inline-body-sentinel',
    );
  });

  it('never changes provider truth when diagnostic callbacks fail', async () => {
    const telemetry = createHttpProviderTelemetry({
      count: () => {
        throw new Error('metrics unavailable');
      },
      duration: vi.fn(),
      rateLimit: vi.fn(),
      trace: () => {
        throw new Error('tracer unavailable');
      },
    });

    await expect(
      telemetry.measure(() => Promise.resolve(artifactOutput)),
    ).resolves.toBe(artifactOutput);
  });

  it.each([
    'before_callback',
    'before_callback_async',
    'after_callback_sync',
    'after_callback_async',
  ] as const)(
    'executes success and rejection once when tracing fails %s',
    async (stage) => {
      const trace = <T>(work: () => Promise<T>): Promise<T> => {
        if (stage === 'before_callback') throw new Error('trace start failed');
        if (stage === 'before_callback_async')
          return Promise.reject(new Error('async trace start failed'));
        const result = work();
        if (stage === 'after_callback_sync')
          throw new Error('trace wrapper failed');
        void result;
        return Promise.reject(new Error('async trace wrapper failed'));
      };
      const telemetry = createHttpProviderTelemetry({
        count: vi.fn(),
        duration: vi.fn(),
        rateLimit: vi.fn(),
        trace,
      });
      const successfulWork = vi.fn(() => Promise.resolve(artifactOutput));
      await expect(telemetry.measure(successfulWork)).resolves.toBe(
        artifactOutput,
      );
      expect(successfulWork).toHaveBeenCalledOnce();

      const failure = new HttpRequestExecutorError(
        { kind: 'failed', errorKind: 'provider' },
        true,
      );
      const rejectedWork = vi.fn(() => Promise.reject(failure));
      await expect(telemetry.measure(rejectedWork)).rejects.toBe(failure);
      expect(rejectedWork).toHaveBeenCalledOnce();
    },
  );

  it.each(['count', 'annotate', 'duration', 'rate_limit'] as const)(
    'preserves the original HTTP rejection when %s recording fails',
    async (stage) => {
      const diagnosticFailure = (): void => {
        throw new Error(`${stage} failed`);
      };
      const telemetry = createHttpProviderTelemetry({
        ...(stage === 'annotate' ? { annotate: diagnosticFailure } : {}),
        count: stage === 'count' ? diagnosticFailure : vi.fn(),
        duration: stage === 'duration' ? diagnosticFailure : vi.fn(),
        rateLimit: stage === 'rate_limit' ? diagnosticFailure : vi.fn(),
        trace: (work) => work(),
      });
      const failure = new HttpRequestExecutorError(
        { kind: 'retry', errorKind: 'rate_limit', reuseProviderKey: true },
        true,
      );
      const work = vi.fn(() => Promise.reject(failure));

      await expect(telemetry.measure(work)).rejects.toBe(failure);
      expect(work).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [{ kind: 'failed', errorKind: 'authentication' }, false],
    [{ kind: 'retry', errorKind: 'network', reuseProviderKey: false }, false],
    [{ kind: 'canceled', errorKind: 'canceled' }, true],
    [{ kind: 'outcome_unknown', errorKind: 'provider' }, true],
  ] as const)(
    'records HTTP decision %# without changing rejection identity',
    async (decision, possiblyDispatched) => {
      const count = vi.fn();
      const telemetry = createHttpProviderTelemetry({
        count,
        duration: vi.fn(),
        rateLimit: vi.fn(),
        trace: (work) => work(),
      });
      const failure = new HttpRequestExecutorError(
        decision,
        possiblyDispatched,
      );

      await expect(
        telemetry.measure(() => Promise.reject(failure)),
      ).rejects.toBe(failure);
      expect(count).toHaveBeenCalledWith(
        expect.objectContaining({
          errorClass: decision.errorKind,
          outcome: decision.kind,
          possiblyDispatched,
        }),
      );
    },
  );

  it.each([
    () => {
      throw new Error('clock failed');
    },
    () => Number.NaN,
    () => Number.POSITIVE_INFINITY,
    () => Number.NEGATIVE_INFINITY,
  ])('bounds throwing and non-finite clocks', async (monotonicNow) => {
    const duration = vi.fn();
    const telemetry = createHttpProviderTelemetry({
      count: vi.fn(),
      duration,
      rateLimit: vi.fn(),
      trace: (work) => work(),
      monotonicNow,
    });

    await telemetry.measure(() => Promise.resolve(artifactOutput));
    expect(duration).toHaveBeenCalledWith(expect.any(Object), 0);
  });

  it('preserves a hostile HTTP rejection when classification traps', async () => {
    const telemetry = createHttpProviderTelemetry({
      count: vi.fn(),
      duration: vi.fn(),
      rateLimit: vi.fn(),
      trace: (work) => work(),
    });
    const revoked = Proxy.revocable(new Error('private provider body'), {});
    revoked.revoke();
    const work = vi.fn(() => Promise.reject(revoked.proxy));

    await expect(telemetry.measure(work)).rejects.toBe(revoked.proxy);
    expect(work).toHaveBeenCalledOnce();
  });

  it('binds production spans and metrics only to fixed-cardinality attributes', async () => {
    const counterCalls = new Map<string, ReturnType<typeof vi.fn>>();
    const histogramCalls = new Map<string, ReturnType<typeof vi.fn>>();
    const createCounter = vi.fn((name: string) => {
      const add = vi.fn();
      counterCalls.set(name, add);
      return { add };
    });
    const createHistogram = vi.fn((name: string) => {
      const record = vi.fn();
      histogramCalls.set(name, record);
      return { record };
    });
    const setAttribute = vi.fn();
    const setStatus = vi.fn();
    const end = vi.fn();
    const span = { end, setAttribute, setStatus } as unknown as Span;
    const startActiveSpan = vi.fn(
      (_name: string, callback: (activeSpan: Span) => Promise<unknown>) =>
        callback(span),
    );
    const telemetry = createProductionHttpProviderTelemetry({
      meter: { createCounter, createHistogram } as unknown as Meter,
      tracer: { startActiveSpan } as unknown as Tracer,
    });

    await expect(
      telemetry.measure(() => Promise.resolve(artifactOutput)),
    ).resolves.toBe(artifactOutput);

    const expectedAttributes = {
      provider_key: 'http',
      operation_key: 'request',
      outcome: 'succeeded',
      possibly_dispatched: true,
      response_storage: 'artifact',
      status_class: '2xx',
    };
    expect(
      counterCalls.get('pertexo.provider.request.count'),
    ).toHaveBeenCalledWith(1, expectedAttributes);
    expect(
      histogramCalls.get('pertexo.provider.request.duration'),
    ).toHaveBeenCalledWith(expect.any(Number), expectedAttributes);
    expect(startActiveSpan).toHaveBeenCalledWith(
      'pertexo.provider.http.request',
      expect.any(Function),
    );
    expect(setAttribute.mock.calls).toEqual(
      Object.entries(expectedAttributes).map(([name, value]) => [name, value]),
    );
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(end).toHaveBeenCalledOnce();
  });

  it.each(['start', 'start_async', 'attribute', 'status', 'end'] as const)(
    'keeps production HTTP work single and truthful when span %s fails',
    async (stage) => {
      const work = vi.fn(() => Promise.resolve(artifactOutput));
      const span = {
        setAttribute: () => {
          if (stage === 'attribute') throw new Error('attribute failed');
        },
        setStatus: () => {
          if (stage === 'status') throw new Error('status failed');
        },
        end: () => {
          if (stage === 'end') throw new Error('end failed');
        },
      } as unknown as Span;
      const tracer = {
        startActiveSpan: (
          _name: string,
          callback: (activeSpan: Span) => Promise<unknown>,
        ) => {
          if (stage === 'start') throw new Error('span start failed');
          if (stage === 'start_async')
            return Promise.reject(new Error('async span start failed'));
          return callback(span);
        },
      } as unknown as Tracer;
      const telemetry = createProductionHttpProviderTelemetry({
        meter: {
          createCounter: () => ({ add: vi.fn() }),
          createHistogram: () => ({ record: vi.fn() }),
        } as unknown as Meter,
        tracer,
      });

      await expect(telemetry.measure(work)).resolves.toBe(artifactOutput);
      expect(work).toHaveBeenCalledOnce();
      const failure = new HttpRequestExecutorError(
        { kind: 'failed', errorKind: 'provider' },
        true,
      );
      const rejectedWork = vi.fn(() => Promise.reject(failure));
      await expect(telemetry.measure(rejectedWork)).rejects.toBe(failure);
      expect(rejectedWork).toHaveBeenCalledOnce();
    },
  );
});
