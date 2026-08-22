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
    expect(Object.keys(expectedAttributes)).not.toEqual(
      expect.arrayContaining(['connection_id', 'run_id', 'url', 'workflow_id']),
    );
  });
});
