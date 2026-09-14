import {
  metrics,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebhookIngressTelemetry } from '../../src/webhooks/telemetry.js';

describe('webhook ingress telemetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to no-op diagnostics when instruments cannot be created', async () => {
    vi.spyOn(metrics, 'getMeter').mockImplementation(() => {
      throw new Error('meter unavailable');
    });
    const telemetry = createWebhookIngressTelemetry();
    const work = vi.fn().mockResolvedValue('accepted');

    await expect(telemetry.trace(undefined, work)).resolves.toBe('accepted');
    expect(telemetry.traceparent()).toBeUndefined();
    expect(() => {
      telemetry.delivery('accepted');
    }).not.toThrow();
    expect(work).toHaveBeenCalledOnce();
  });

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
    const parentTraceId = 'a'.repeat(32);
    const parentSpanId = 'b'.repeat(16);
    let persistedTraceparent: string | undefined;

    try {
      const telemetry = createWebhookIngressTelemetry();
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

  it.each([
    '00-00000000000000000000000000000000-bbbbbbbbbbbbbbbb-01',
    '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000000-01',
    'not-a-traceparent',
    undefined,
  ])(
    'falls back to the active context for invalid or absent parent %s',
    async (parent) => {
      let selectedParent: Context | undefined;
      vi.spyOn(trace, 'getTracer').mockReturnValue({
        startActiveSpan: vi.fn((...args: unknown[]) => {
          selectedParent = args[2] as Context;
          const callback = args.at(-1) as (span: Span) => Promise<unknown>;
          return callback(span());
        }),
      } as never);
      const telemetry = createWebhookIngressTelemetry();

      await telemetry.trace(parent, () => Promise.resolve());

      if (selectedParent === undefined)
        throw new Error('Tracer did not receive a parent context');
      expect(trace.getSpanContext(selectedParent)).toBeUndefined();
    },
  );

  it.each([
    {
      name: 'a synchronous tracer failure before its callback',
      start: (callback: (span: Span) => Promise<unknown>) => {
        void callback;
        throw new Error('trace failed before callback');
      },
    },
    {
      name: 'a tracer rejection before its callback',
      start: (callback: (span: Span) => Promise<unknown>) => {
        void callback;
        return Promise.reject(new Error('trace rejected before callback'));
      },
    },
    {
      name: 'a synchronous tracer failure after its callback',
      start: (callback: (span: Span) => Promise<unknown>) => {
        void callback(span());
        throw new Error('trace failed after callback');
      },
    },
    {
      name: 'a tracer rejection after its callback',
      start: (callback: (span: Span) => Promise<unknown>) => {
        void callback(span());
        return Promise.reject(new Error('trace rejected after callback'));
      },
    },
  ] as const)('runs work exactly once through $name', async ({ start }) => {
    useTracer(start);
    const telemetry = createWebhookIngressTelemetry();
    const result = Object.freeze({ status: 'accepted' });
    const work = vi.fn().mockResolvedValue(result);

    await expect(telemetry.trace(undefined, work)).resolves.toBe(result);
    expect(work).toHaveBeenCalledOnce();
  });

  it('returns one business promise and ends a duplicate callback span', async () => {
    const firstSpan = span();
    const duplicateSpan = span();
    useTracer((callback) => {
      const first = callback(firstSpan);
      const second = callback(duplicateSpan);
      expect(second).toBe(first);
      return first;
    });
    const telemetry = createWebhookIngressTelemetry();
    const work = vi.fn().mockResolvedValue('accepted');

    await expect(telemetry.trace(undefined, work)).resolves.toBe('accepted');
    expect(work).toHaveBeenCalledOnce();
    expect(firstSpan.end.mock.calls).toHaveLength(1);
    expect(duplicateSpan.end.mock.calls).toHaveLength(1);
  });

  it('contains span end failure after successful work', async () => {
    const diagnosticSpan = span();
    diagnosticSpan.end.mockImplementation(() => {
      throw new Error('span end unavailable');
    });
    useTracer((callback) => callback(diagnosticSpan));
    const telemetry = createWebhookIngressTelemetry();

    await expect(
      telemetry.trace(undefined, () => Promise.resolve('accepted')),
    ).resolves.toBe('accepted');
  });

  it('preserves failed work when status and end diagnostics both fail', async () => {
    const diagnosticSpan = span();
    diagnosticSpan.setStatus.mockImplementation(() => {
      throw new Error('span status unavailable');
    });
    diagnosticSpan.end.mockImplementation(() => {
      throw new Error('span end unavailable');
    });
    useTracer((callback) => callback(diagnosticSpan));
    const telemetry = createWebhookIngressTelemetry();
    const failure = new Error('acceptance failed');

    await expect(
      telemetry.trace(undefined, () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(diagnosticSpan.setStatus.mock.calls).toEqual([
      [
        {
          code: SpanStatusCode.ERROR,
        },
      ],
    ]);
    expect(diagnosticSpan.end.mock.calls).toHaveLength(1);
  });
});

function useTracer(
  start: (callback: (span: Span) => Promise<unknown>) => unknown,
): void {
  vi.spyOn(trace, 'getTracer').mockReturnValue({
    startActiveSpan: vi.fn((...args: unknown[]) => {
      const callback = args.at(-1) as (span: Span) => Promise<unknown>;
      return start(callback);
    }),
  } as never);
}

function span() {
  return {
    end: vi.fn(),
    setStatus: vi.fn(),
  } as unknown as Span & {
    end: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  };
}

interface ExportedSpan {
  readonly name: string;
  readonly parentSpanContext?: Readonly<{
    isRemote?: boolean;
    spanId: string;
    traceId: string;
  }>;
  spanContext(): Readonly<{ spanId: string }>;
}
