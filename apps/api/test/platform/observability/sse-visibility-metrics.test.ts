import type { Meter } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import {
  createSseVisibilityMetrics,
  SSE_VISIBILITY_METRIC_NAME,
  type SseVisibilityPath,
} from '../../../src/platform/observability/sse-visibility-metrics.js';

const paths: readonly SseVisibilityPath[] = [
  'initial_backfill',
  'reconnect_backfill',
  'live_wakeup',
  'recovery_backfill',
];

function fixture(now: number) {
  const duration = vi.fn();
  const skew = vi.fn();
  const createHistogram = vi.fn(() => ({ record: duration }));
  const meter = {
    createHistogram,
    createCounter: vi.fn(() => ({ add: skew })),
  } as unknown as Meter;
  return {
    duration,
    createHistogram,
    metrics: createSseVisibilityMetrics({ meter, now: () => now }),
    skew,
  };
}

describe('SSE visibility metrics', () => {
  it.each(['histogram', 'counter'] as const)(
    'falls back to a no-op when %s construction throws',
    (instrument) => {
      const failure = new Error(`${instrument} construction failed`);
      const meter = {
        createHistogram:
          instrument === 'histogram'
            ? vi.fn(() => {
                throw failure;
              })
            : vi.fn(() => ({ record: vi.fn() })),
        createCounter:
          instrument === 'counter'
            ? vi.fn(() => {
                throw failure;
              })
            : vi.fn(() => ({ add: vi.fn() })),
      } as unknown as Meter;

      const selected = createSseVisibilityMetrics({ meter });

      expect(() => {
        selected.recordFirstEligibleFrame({
          createdAt: new Date('2026-08-21T12:00:00.000Z'),
          path: 'initial_backfill',
        });
      }).not.toThrow();
    },
  );

  it.each(['clock', 'histogram', 'counter'] as const)(
    'contains a throwing %s while recording',
    (failurePoint) => {
      const duration = vi.fn(() => {
        if (failurePoint === 'histogram') throw new Error('duration failed');
      });
      const skew = vi.fn(() => {
        if (failurePoint === 'counter') throw new Error('skew failed');
      });
      const meter = {
        createHistogram: vi.fn(() => ({ record: duration })),
        createCounter: vi.fn(() => ({ add: skew })),
      } as unknown as Meter;
      const selected = createSseVisibilityMetrics({
        meter,
        now: () => {
          if (failurePoint === 'clock') throw new Error('clock failed');
          return failurePoint === 'counter'
            ? Date.parse('2026-08-21T11:59:59.000Z')
            : Date.parse('2026-08-21T12:00:01.000Z');
        },
      });

      expect(() => {
        selected.recordFirstEligibleFrame({
          createdAt: new Date('2026-08-21T12:00:00.000Z'),
          path: 'live_wakeup',
        });
      }).not.toThrow();
    },
  );

  it.each(paths)('records exact zero latency for the %s path', (path) => {
    const selected = fixture(Date.parse('2026-08-21T12:00:00.000Z'));

    selected.metrics.recordFirstEligibleFrame({
      createdAt: new Date('2026-08-21T12:00:00.000Z'),
      path,
    });

    expect(selected.createHistogram).toHaveBeenCalledWith(
      SSE_VISIBILITY_METRIC_NAME.persistedToVisible,
      expect.objectContaining({ unit: 's' }),
    );
    expect(selected.duration).toHaveBeenCalledWith(0, { path });
    expect(selected.skew).not.toHaveBeenCalled();
  });

  it('records exact positive latency without tenant dimensions', () => {
    const selected = fixture(Date.parse('2026-08-21T12:00:02.500Z'));

    selected.metrics.recordFirstEligibleFrame({
      createdAt: new Date('2026-08-21T12:00:00.000Z'),
      path: 'live_wakeup',
    });

    expect(selected.duration).toHaveBeenCalledWith(2.5, {
      path: 'live_wakeup',
    });
    expect(selected.duration.mock.calls[0]?.[1]).toEqual({
      path: 'live_wakeup',
    });
  });

  it.each([
    ['future timestamp', Date.now(), new Date(Date.now() + 1)],
    ['invalid date', Date.now(), new Date(Number.NaN)],
    ['non-finite clock', Number.POSITIVE_INFINITY, new Date()],
  ])(
    'counts %s as skew and excludes the histogram',
    (_name, now, createdAt) => {
      const selected = fixture(now);

      selected.metrics.recordFirstEligibleFrame({
        createdAt,
        path: 'recovery_backfill',
      });

      expect(selected.duration).not.toHaveBeenCalled();
      expect(selected.skew).toHaveBeenCalledOnce();
      expect(selected.skew).toHaveBeenCalledWith(1, {
        path: 'recovery_backfill',
      });
    },
  );
});
