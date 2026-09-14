import type { Attributes, Meter } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import { createTriggerRuntimeTelemetry } from '../src/triggers/trigger-telemetry.js';

type InstrumentCall = Readonly<{
  attributes?: Attributes;
  value: number;
}>;

function meterHarness() {
  const counters = new Map<string, InstrumentCall[]>();
  const histograms = new Map<string, InstrumentCall[]>();
  const record = (
    collection: Map<string, InstrumentCall[]>,
    name: string,
    value: number,
    attributes?: Attributes,
  ): void => {
    const calls = collection.get(name) ?? [];
    calls.push({ ...(attributes === undefined ? {} : { attributes }), value });
    collection.set(name, calls);
  };
  const meter = {
    createCounter: vi.fn((name: string) => ({
      add: (value: number, attributes?: Attributes) => {
        record(counters, name, value, attributes);
      },
    })),
    createHistogram: vi.fn((name: string) => ({
      record: (value: number, attributes?: Attributes) => {
        record(histograms, name, value, attributes);
      },
    })),
  } as unknown as Meter;
  return { counters, histograms, meter };
}

describe('trigger runtime telemetry', () => {
  it('records exact reconciliation, occurrence, lag, duration and health instruments', () => {
    const harness = meterHarness();
    const telemetry = createTriggerRuntimeTelemetry(harness.meter);

    telemetry.reconciliationCompleted('succeeded');
    telemetry.reconciliationCompleted('failed');
    telemetry.scanCompleted(
      { accepted: 2, claimed: 5, deferred: 0, maxLagSeconds: 4.5, skipped: 3 },
      1.25,
    );
    telemetry.scanCompleted(
      { accepted: 1, claimed: 3, deferred: 2, maxLagSeconds: 8, skipped: 0 },
      2.5,
    );
    telemetry.scanFailed(3.75);

    expect(
      harness.counters.get('pertexo.trigger.reconciliation.count'),
    ).toEqual([
      { attributes: { outcome: 'succeeded' }, value: 1 },
      { attributes: { outcome: 'failed' }, value: 1 },
    ]);
    expect(harness.counters.get('pertexo.schedule.scan.count')).toEqual([
      { attributes: { outcome: 'succeeded' }, value: 1 },
      { attributes: { outcome: 'succeeded' }, value: 1 },
      { attributes: { outcome: 'failed' }, value: 1 },
    ]);
    expect(harness.counters.get('pertexo.schedule.occurrence.count')).toEqual([
      { attributes: { outcome: 'accepted' }, value: 2 },
      { attributes: { outcome: 'deferred' }, value: 0 },
      { attributes: { outcome: 'skipped' }, value: 3 },
      { attributes: { outcome: 'accepted' }, value: 1 },
      { attributes: { outcome: 'deferred' }, value: 2 },
      { attributes: { outcome: 'skipped' }, value: 0 },
    ]);
    expect(harness.histograms.get('pertexo.schedule.scan.duration')).toEqual([
      { attributes: { outcome: 'succeeded' }, value: 1.25 },
      { attributes: { outcome: 'succeeded' }, value: 2.5 },
      { attributes: { outcome: 'failed' }, value: 3.75 },
    ]);
    expect(harness.histograms.get('pertexo.schedule.lag')).toEqual([
      { value: 4.5 },
      { value: 8 },
    ]);
    expect(harness.counters.get('pertexo.trigger.health.count')).toEqual([
      { attributes: { status: 'healthy' }, value: 1 },
      { attributes: { status: 'throttled' }, value: 1 },
      { attributes: { status: 'degraded' }, value: 1 },
    ]);
  });
});
