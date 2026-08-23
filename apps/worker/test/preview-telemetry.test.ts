import type { Attributes, Meter } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import {
  createPreviewTelemetry,
  createProductionPreviewTelemetry,
} from '../src/execution/preview-telemetry.js';

type Measurement = Readonly<{
  attributes?: Attributes;
  value: number;
}>;

function meterHarness(): {
  counters: Map<string, Measurement[]>;
  meter: Meter;
} {
  const counters = new Map<string, Measurement[]>();
  const meter = {
    createCounter: vi.fn((name: string) => ({
      add: (value: number, attributes?: Attributes): void => {
        const measurements = counters.get(name) ?? [];
        measurements.push({
          ...(attributes === undefined ? {} : { attributes }),
          value,
        });
        counters.set(name, measurements);
      },
    })),
  } as unknown as Meter;
  return { counters, meter };
}

describe('preview telemetry', () => {
  it('emits only bounded terminal and reconciliation classifications', () => {
    const harness = meterHarness();
    const telemetry = createProductionPreviewTelemetry(harness.meter);

    telemetry.recordTerminal({
      mayContactProvider: true,
      mayCauseExternalSideEffect: true,
      outcome: 'outcome_unknown',
      possiblyDispatched: true,
      sideEffectClass: 'unsafe',
      source: 'execution',
      usesConnection: true,
    });
    telemetry.recordReconciliation({
      decision: 'completed',
      outcome: 'outcome_unknown',
    });

    expect(harness.counters.get('pertexo.preview.terminal.count')).toEqual([
      {
        attributes: {
          may_contact_provider: true,
          may_cause_external_side_effect: true,
          outcome: 'outcome_unknown',
          possibly_dispatched: true,
          side_effect_class: 'unsafe',
          source: 'execution',
          uses_connection: true,
        },
        value: 1,
      },
    ]);
    expect(
      harness.counters.get('pertexo.preview.reconciliation.count'),
    ).toEqual([
      {
        attributes: {
          decision: 'completed',
          outcome: 'outcome_unknown',
        },
        value: 1,
      },
    ]);
    expect(JSON.stringify([...harness.counters.values()])).not.toMatch(
      /workspace|run_id|node_id|user|url|connection_id|connection_key/u,
    );
  });

  it('isolates metrics failures from committed preview truth', () => {
    const telemetry = createPreviewTelemetry({
      reconciliation: () => {
        throw new Error('collector unavailable');
      },
      terminal: () => {
        throw new Error('collector unavailable');
      },
    });

    expect(() => {
      telemetry.recordTerminal({ outcome: 'failed', source: 'execution' });
    }).not.toThrow();
    expect(() => {
      telemetry.recordReconciliation({ decision: 'duplicate' });
    }).not.toThrow();
  });
});
