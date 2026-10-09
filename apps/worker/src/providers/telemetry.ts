import {
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type Meter,
  type Tracer,
} from '@opentelemetry/api';
import type {
  EmailSendNotificationOutput,
  HttpRequestOutput,
  SlackSendMessageOutput,
} from '@pertexo/integrations';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';

export type ProviderTelemetryOptions = Readonly<{
  meter?: Meter;
  tracer?: Tracer;
}>;

export type ProviderTelemetry<Output> = Readonly<{
  measure(work: () => Promise<Output>): Promise<Output>;
}>;

/**
 * Counts, times and traces each provider call. Attributes are bounded: the
 * provider, operation, outcome, error class and whether the call may have
 * dispatched. Provider output and error details never reach telemetry.
 */
function createProviderTelemetry<Output>(
  provider: Readonly<{
    key: string;
    operation: string;
    successAttributes?: (output: Output) => Attributes;
  }>,
  options: ProviderTelemetryOptions,
): ProviderTelemetry<Output> {
  const name = `@pertexo/worker.provider-${provider.key}`;
  const meter = options.meter ?? metrics.getMeter(name);
  const tracer = options.tracer ?? trace.getTracer(name);
  const count = meter.createCounter('pertexo.provider.request.count', {
    description:
      'Completed provider requests by bounded provider/operation/outcome',
    unit: '{request}',
  });
  const duration = meter.createHistogram('pertexo.provider.request.duration', {
    description:
      'Provider request duration by bounded provider/operation/outcome',
    unit: 's',
  });
  const rateLimit = meter.createCounter('pertexo.provider.rate_limit.count', {
    description: 'Provider rate-limit outcomes by bounded provider/operation',
    unit: '{event}',
  });
  const identity = {
    provider_key: provider.key,
    operation_key: provider.operation,
  };
  return Object.freeze({
    measure: (work: () => Promise<Output>) =>
      tracer.startActiveSpan(
        `pertexo.provider.${provider.key}.${provider.operation}`,
        async (span) => {
          const startedAt = performance.now();
          let attributes: Attributes = {
            ...identity,
            outcome: 'succeeded',
            possibly_dispatched: true,
          };
          try {
            const output = await work();
            attributes = {
              ...attributes,
              ...provider.successAttributes?.(output),
            };
            return output;
          } catch (error: unknown) {
            attributes = { ...identity, ...failureAttributes(error) };
            throw error;
          } finally {
            count.add(1, attributes);
            duration.record(
              (performance.now() - startedAt) / 1_000,
              attributes,
            );
            if (attributes.error_class === 'rate_limit')
              rateLimit.add(1, attributes);
            span.setAttributes(attributes);
            span.setStatus({
              code:
                attributes.outcome === 'succeeded'
                  ? SpanStatusCode.OK
                  : SpanStatusCode.ERROR,
            });
            span.end();
          }
        },
      ),
  });
}

function failureAttributes(error: unknown): Attributes {
  return error instanceof NodeExecutorFailure
    ? {
        outcome: error.kind,
        error_class: error.errorKind,
        possibly_dispatched: error.possiblyDispatched,
      }
    : {
        outcome: 'failed',
        error_class: 'internal',
        possibly_dispatched: false,
      };
}

export function createHttpProviderTelemetry(
  options: ProviderTelemetryOptions = {},
): ProviderTelemetry<HttpRequestOutput> {
  return createProviderTelemetry<HttpRequestOutput>(
    {
      key: 'http',
      operation: 'request',
      successAttributes: (output) => ({
        response_storage: output.body.kind,
        status_class: '2xx',
      }),
    },
    options,
  );
}

export function createSlackProviderTelemetry(
  options: ProviderTelemetryOptions = {},
): ProviderTelemetry<SlackSendMessageOutput> {
  return createProviderTelemetry<SlackSendMessageOutput>(
    { key: 'slack', operation: 'send_message' },
    options,
  );
}

export function createEmailProviderTelemetry(
  options: ProviderTelemetryOptions = {},
): ProviderTelemetry<EmailSendNotificationOutput> {
  return createProviderTelemetry<EmailSendNotificationOutput>(
    { key: 'email', operation: 'send_notification' },
    options,
  );
}
