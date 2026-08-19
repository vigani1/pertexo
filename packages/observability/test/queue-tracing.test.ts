import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Context,
  type Span,
  type TextMapPropagator,
  type Tracer,
} from '@opentelemetry/api';
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
    expect(proof.span.recordException).toHaveBeenCalledWith(failure);
    expect(proof.span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
    });
    expect(proof.span.end).toHaveBeenCalledOnce();
  });
});
