import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type TextMapPropagator,
  type TextMapGetter,
  type Tracer,
} from '@opentelemetry/api';

import './server-only.js';

export interface QueueTraceObservation {
  readonly jobName: string;
  readonly queueName: string;
}

export interface QueueTraceRunner {
  run<T>(
    traceparent: string | undefined,
    observation: QueueTraceObservation,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export type QueueTraceRunnerOptions = Readonly<{
  activeContext?: () => Context;
  propagator?: TextMapPropagator;
  tracer?: Tracer;
}>;

const TRACE_CARRIER_GETTER: TextMapGetter<Record<string, string>> = {
  get(carrier, key): string | undefined {
    return carrier[key];
  },
  keys(carrier): string[] {
    return Object.keys(carrier);
  },
};

/** Extracts the validated W3C parent and activates one bounded consumer span. */
export function createQueueTraceRunner(
  options: QueueTraceRunnerOptions = {},
): QueueTraceRunner {
  const tracer =
    options.tracer ?? trace.getTracer('@pertexo/observability.queue', '0.0.0');
  const propagator = options.propagator ?? propagation;
  const activeContext = options.activeContext ?? (() => context.active());

  return Object.freeze({
    run<T>(
      traceparent: string | undefined,
      observation: QueueTraceObservation,
      operation: () => Promise<T>,
    ): Promise<T> {
      const parent =
        traceparent === undefined
          ? activeContext()
          : propagator.extract(
              activeContext(),
              { traceparent },
              TRACE_CARRIER_GETTER,
            );
      return tracer.startActiveSpan(
        'transport.queue.handler',
        {
          attributes: {
            'messaging.destination.name': observation.queueName,
            'messaging.operation.name': 'process',
            'messaging.operation.type': 'process',
            'pertexo.job.name': observation.jobName,
          },
          kind: SpanKind.CONSUMER,
        },
        parent,
        async (span) => {
          try {
            const value = await operation();
            span.setStatus({ code: SpanStatusCode.OK });
            return value;
          } catch (error: unknown) {
            span.recordException(
              error instanceof Error
                ? error
                : new Error('Queue handler failed'),
            );
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            span.end();
          }
        },
      );
    },
  });
}
