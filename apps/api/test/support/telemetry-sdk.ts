import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { MetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace';

/** Reads on demand, so a test sees exactly what the SDK has aggregated. */
class CollectingMetricReader extends MetricReader {
  protected override onForceFlush(): Promise<void> {
    return Promise.resolve();
  }

  protected override onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export type RecordedPoint = Readonly<{
  attributes: Readonly<Record<string, unknown>>;
  unit: string;
  value: unknown;
}>;

/**
 * Runs the real OpenTelemetry SDK as this process's global provider and keeps
 * what it records in memory. Start it before the code under test asks for a
 * meter: the API hands out a no-op meter while no provider is registered.
 */
export function startTelemetrySdk() {
  const spans = new InMemorySpanExporter();
  const reader = new CollectingMetricReader();
  const sdk = new NodeSDK({
    instrumentations: [],
    metricReaders: [reader],
    resourceDetectors: [],
    spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
  });
  sdk.start();
  return {
    spans: () => spans.getFinishedSpans(),
    async points(name: string): Promise<readonly RecordedPoint[]> {
      const { resourceMetrics } = await reader.collect();
      return resourceMetrics.scopeMetrics
        .flatMap(({ metrics: recorded }) => recorded)
        .filter(({ descriptor }) => descriptor.name === name)
        .flatMap(({ descriptor, dataPoints }) =>
          dataPoints.map((point) => ({
            attributes: point.attributes,
            unit: descriptor.unit,
            value: point.value,
          })),
        );
    },
    async stop(): Promise<void> {
      try {
        await sdk.shutdown();
      } finally {
        // Shutdown leaves the globals registered; the next file starts clean.
        trace.disable();
        metrics.disable();
        context.disable();
        propagation.disable();
      }
    },
  };
}

export type TelemetrySdk = ReturnType<typeof startTelemetrySdk>;
