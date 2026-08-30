import type { Meter } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import { createSseVisibilityMetrics } from '../../../src/platform/observability/sse-visibility-metrics.js';

describe('SSE visibility load assertion', () => {
  it('keeps a representative admitted stream under the two-second p95 objective', () => {
    const observations: number[] = [];
    const attributes: unknown[] = [];
    const meter = {
      createHistogram: vi.fn(() => ({
        record: (value: number, labels: unknown) => {
          observations.push(value);
          attributes.push(labels);
        },
      })),
      createCounter: vi.fn(() => ({ add: vi.fn() })),
    } as unknown as Meter;
    const now = Date.parse('2026-08-21T12:00:00.250Z');
    const visibility = createSseVisibilityMetrics({ meter, now: () => now });

    for (let index = 0; index < 1_000; index += 1) {
      visibility.recordFirstEligibleFrame({
        createdAt: new Date('2026-08-21T12:00:00.000Z'),
        path: index % 2 === 0 ? 'live_wakeup' : 'initial_backfill',
      });
    }

    const sorted = [...observations].sort((left, right) => left - right);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    expect(observations).toHaveLength(1_000);
    expect(p95).toBeLessThanOrEqual(2);
    expect(new Set(attributes.map((value) => JSON.stringify(value)))).toEqual(
      new Set(['{"path":"live_wakeup"}', '{"path":"initial_backfill"}']),
    );
    expect(JSON.stringify(attributes)).not.toMatch(
      /workspace|workflow|run|event|request|actor/iu,
    );
  });
});
