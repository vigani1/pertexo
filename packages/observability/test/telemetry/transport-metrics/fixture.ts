import type { Attributes, Meter } from '@opentelemetry/api';
import { vi } from 'vitest';

interface Measurement {
  readonly attributes: Attributes | undefined;
  readonly value: number;
}

interface MetricHarness {
  readonly counters: Map<string, Measurement[]>;
  readonly gauges: Map<string, Measurement[]>;
  readonly histograms: Map<string, Measurement[]>;
  readonly meter: Meter;
  readonly upDownCounters: Map<string, Measurement[]>;
}

function measurementInstrument(
  destination: Map<string, Measurement[]>,
  name: string,
): { add(value: number, attributes?: Attributes): void } & {
  record(value: number, attributes?: Attributes): void;
} {
  const measurements: Measurement[] = [];
  destination.set(name, measurements);

  const write = (value: number, attributes?: Attributes): void => {
    measurements.push({ attributes, value });
  };

  return { add: write, record: write };
}

export function metricHarness(): MetricHarness {
  const counters = new Map<string, Measurement[]>();
  const gauges = new Map<string, Measurement[]>();
  const histograms = new Map<string, Measurement[]>();
  const upDownCounters = new Map<string, Measurement[]>();

  const meter = {
    createCounter: vi.fn((name: string) =>
      measurementInstrument(counters, name),
    ),
    createGauge: vi.fn((name: string) => measurementInstrument(gauges, name)),
    createHistogram: vi.fn((name: string) =>
      measurementInstrument(histograms, name),
    ),
    createUpDownCounter: vi.fn((name: string) =>
      measurementInstrument(upDownCounters, name),
    ),
  } as unknown as Meter;

  return { counters, gauges, histograms, meter, upDownCounters };
}

export function values(
  measurements: Map<string, Measurement[]>,
  name: string,
): readonly Measurement[] {
  return measurements.get(name) ?? [];
}

export function recordedMeasurements(
  harness: MetricHarness,
): readonly Measurement[] {
  return [
    ...harness.counters.values(),
    ...harness.gauges.values(),
    ...harness.histograms.values(),
    ...harness.upDownCounters.values(),
  ].flat();
}
