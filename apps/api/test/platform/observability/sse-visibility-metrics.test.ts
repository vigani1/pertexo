import type { Meter } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import {
  createSseVisibilityMetrics,
  SSE_VISIBILITY_METRIC_NAME,
} from '../../../src/platform/observability/sse-visibility-metrics.js';

describe('SSE visibility metrics', () => {
  it('records bounded persisted-to-visible latency with the path only', () => {
    const record = vi.fn();
    const add = vi.fn();
    const createHistogram = vi.fn(() => ({ record }));
    const createCounter = vi.fn(() => ({ add }));
    const meter = {
      createHistogram,
      createCounter,
    } as unknown as Meter;
    const metrics = createSseVisibilityMetrics({
      meter,
      now: () => Date.parse('2026-08-21T12:00:02.500Z'),
    });

    metrics.recordFirstEligibleFrame({
      createdAt: new Date('2026-08-21T12:00:00.000Z'),
      path: 'live_wakeup',
    });

    expect(createHistogram).toHaveBeenCalledWith(
      SSE_VISIBILITY_METRIC_NAME.persistedToVisible,
      expect.objectContaining({ unit: 's' }),
    );
    expect(record).toHaveBeenCalledWith(2.5, { path: 'live_wakeup' });
    expect(JSON.stringify(record.mock.calls)).not.toContain('workspace');
    expect(JSON.stringify(record.mock.calls)).not.toContain('run');
  });

  it('excludes future database timestamps and records bounded clock skew', () => {
    const record = vi.fn();
    const add = vi.fn();
    const createHistogram = vi.fn(() => ({ record }));
    const createCounter = vi.fn(() => ({ add }));
    const meter = {
      createHistogram,
      createCounter,
    } as unknown as Meter;
    const metrics = createSseVisibilityMetrics({
      meter,
      now: () => Date.parse('2026-08-21T12:00:00.000Z'),
    });

    metrics.recordFirstEligibleFrame({
      createdAt: new Date('2026-08-21T12:00:00.001Z'),
      path: 'initial_backfill',
    });

    expect(record).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(1, {
      path: 'initial_backfill',
    });
  });
});
