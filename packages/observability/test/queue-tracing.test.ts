import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Context,
  type Span,
  type TextMapPropagator,
  type Tracer,
} from '@opentelemetry/api';
import { node } from '@opentelemetry/sdk-node';
import { describe, expect, it, vi } from 'vitest';

import { createQueueTraceRunner } from '../src/queue-tracing.js';

/* eslint-disable @typescript-eslint/unbound-method -- assertions target injected OTel boundary fakes */

const TRACEPARENT = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;

function harness(): {
  activeParent: Context;
  extractedParent: Context;
  propagator: TextMapPropagator;
  span: Span;
  tracer: Tracer;
} {
  const activeParent = ROOT_CONTEXT.setValue(Symbol('active'), 'active');
  const extractedParent = ROOT_CONTEXT.setValue(Symbol('remote'), 'remote');
  const span = {
    end: vi.fn(),
    recordException: vi.fn(),
    setStatus: vi.fn(),
  } as unknown as Span;
  const propagator = {
    extract: vi.fn(() => extractedParent),
    fields: vi.fn(() => ['traceparent']),
    inject: vi.fn(),
  } satisfies TextMapPropagator;
  const tracer = {
    startActiveSpan: vi.fn(
      (_name, _options, _parent, callback: (activeSpan: Span) => unknown) =>
        callback(span),
    ),
  } as unknown as Tracer;
  return { activeParent, extractedParent, propagator, span, tracer };
}

describe('createQueueTraceRunner', () => {
  it('extracts traceparent and activates a fixed-cardinality consumer span', async () => {
    const proof = harness();
    const operation = vi.fn(() => Promise.resolve('ok'));
    const runner = createQueueTraceRunner({
      activeContext: () => proof.activeParent,
      propagator: proof.propagator,
      tracer: proof.tracer,
    });

    await expect(
      runner.run(
        TRACEPARENT,
        {
          jobName: 'execute-node-attempt',
          queueName: 'node-attempts',
        },
        operation,
      ),
    ).resolves.toBe('ok');

    expect(proof.propagator.extract).toHaveBeenCalledWith(
      proof.activeParent,
      { traceparent: TRACEPARENT },
      expect.any(Object),
    );
    expect(proof.tracer.startActiveSpan).toHaveBeenCalledWith(
      'transport.queue.handler',
      {
        attributes: {
          'messaging.destination.name': 'node-attempts',
          'messaging.operation.name': 'process',
          'messaging.operation.type': 'process',
          'pertexo.job.name': 'execute-node-attempt',
        },
        kind: SpanKind.CONSUMER,
      },
      proof.extractedParent,
      expect.any(Function),
    );
    expect(operation).toHaveBeenCalledOnce();
    expect(proof.span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.OK,
    });
    expect(proof.span.end).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(vi.mocked(proof.tracer.startActiveSpan).mock.calls),
    ).not.toContain(TRACEPARENT);
  });

  it('records a failed span and preserves handler failure', async () => {
    const proof = harness();
    const failure = new Error('provider unavailable');
    const runner = createQueueTraceRunner({
      activeContext: () => proof.activeParent,
      propagator: proof.propagator,
      tracer: proof.tracer,
    });

    await expect(
      runner.run(
        undefined,
        { jobName: 'expire-artifacts', queueName: 'maintenance' },
        () => Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
    expect(proof.propagator.extract).not.toHaveBeenCalled();
    expect(proof.span.recordException).toHaveBeenCalledWith({ name: 'Error' });
    expect(proof.span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
    });
    expect(proof.span.end).toHaveBeenCalledOnce();
  });

  it('preserves a hostile Proxy rejection when error classification cannot inspect its prototype', async () => {
    const proof = harness();
    const classificationFailure = new Error('prototype inspection failed');
    const rejection = new Proxy(Object.create(null) as object, {
      getPrototypeOf: () => {
        throw classificationFailure;
      },
    });
    const runner = createQueueTraceRunner({
      activeContext: () => proof.activeParent,
      propagator: proof.propagator,
      tracer: proof.tracer,
    });

    await expect(
      runner.run(
        undefined,
        { jobName: 'hostile-rejection', queueName: 'maintenance' },
        // The runner deliberately preserves legacy non-Error rejection identity.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        () => Promise.reject(rejection),
      ),
    ).rejects.toBe(rejection);
    expect(proof.span.recordException).toHaveBeenCalledWith({
      name: 'NonError',
    });
    expect(proof.span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
    });
    expect(proof.span.end).toHaveBeenCalledOnce();
  });

  it('exports bounded exception classifications without reading hostile error properties', async () => {
    const exporter = new node.InMemorySpanExporter();
    const provider = new node.NodeTracerProvider({
      spanProcessors: [new node.SimpleSpanProcessor(exporter)],
    });
    const runner = createQueueTraceRunner({
      tracer: provider.getTracer('queue-tracing-test'),
    });
    const secrets = [
      'queue-message-secret',
      'queue-stack-secret',
      'queue-cause-secret',
      'queue-name-secret',
      'queue-code-secret',
      'queue-non-error-secret',
    ];
    const getterCalls = {
      cause: 0,
      code: 0,
      message: 0,
      name: 0,
      stack: 0,
    };
    const hostileError = new Error('unused');
    for (const [property, secret] of [
      ['cause', secrets[2]],
      ['code', secrets[4]],
      ['message', secrets[0]],
      ['name', secrets[3]],
      ['stack', secrets[1]],
    ] as const) {
      Object.defineProperty(hostileError, property, {
        configurable: true,
        get: () => {
          getterCalls[property] += 1;
          return secret;
        },
      });
    }
    const hostileNonError = Object.create(null) as Record<string, unknown>;
    for (const [property, secret] of [
      ['cause', secrets[2]],
      ['code', secrets[4]],
      ['message', secrets[0]],
      ['name', secrets[3]],
      ['stack', secrets[1]],
    ] as const) {
      Object.defineProperty(hostileNonError, property, {
        configurable: true,
        get: () => {
          getterCalls[property] += 1;
          return secret;
        },
      });
    }

    await expect(
      runner.run(
        undefined,
        { jobName: 'queue-error', queueName: 'maintenance' },
        () => Promise.reject(hostileError),
      ),
    ).rejects.toBe(hostileError);
    await expect(
      runner.run(
        undefined,
        { jobName: 'queue-non-error', queueName: 'maintenance' },
        // The runner deliberately preserves legacy non-Error rejection identity.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        () => Promise.reject(hostileNonError),
      ),
    ).rejects.toBe(hostileNonError);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    expect(spans.map((span) => span.status.code)).toEqual([
      SpanStatusCode.ERROR,
      SpanStatusCode.ERROR,
    ]);
    expect(spans[0]?.events[0]?.attributes).toEqual({
      'exception.type': 'Error',
    });
    expect(spans[1]?.events[0]?.attributes).toEqual({
      'exception.type': 'NonError',
    });
    expect(getterCalls).toEqual({
      cause: 0,
      code: 0,
      message: 0,
      name: 0,
      stack: 0,
    });
    const serialized = JSON.stringify(
      spans.map((span) => ({
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    );
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
  });
});
