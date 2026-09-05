import type { Meter } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import {
  createMaintenanceMetrics,
  MAINTENANCE_METRIC_NAME,
} from '../src/maintenance-metrics.js';

describe('maintenance metrics', () => {
  it('uses only finite command and outcome dimensions', () => {
    const add = vi.fn();
    const record = vi.fn();
    const createCounter = vi.fn(() => ({ add }));
    const createHistogram = vi.fn(() => ({ record }));
    const metrics = createMaintenanceMetrics({
      createCounter,
      createHistogram,
    } as unknown as Meter);

    metrics.recordLifecycleCommand('deletion_requested', 'completed', 0.25);
    metrics.recordControlLedgerReconciliation('agreed', 1.5);

    expect(createCounter).toHaveBeenCalledWith(
      MAINTENANCE_METRIC_NAME.lifecycleCommandProcess,
      expect.any(Object),
    );
    expect(add).toHaveBeenNthCalledWith(1, 1, {
      command_type: 'deletion_requested',
      outcome: 'completed',
    });
    expect(add).toHaveBeenNthCalledWith(2, 1, { outcome: 'agreed' });
    expect(record).toHaveBeenNthCalledWith(1, 0.25, {
      command_type: 'deletion_requested',
      outcome: 'completed',
    });
    expect(record).toHaveBeenNthCalledWith(2, 1.5, { outcome: 'agreed' });
  });

  it('rejects invalid duration measurements before recording anything', () => {
    const add = vi.fn();
    const record = vi.fn();
    const metrics = createMaintenanceMetrics({
      createCounter: vi.fn(() => ({ add })),
      createHistogram: vi.fn(() => ({ record })),
    } as unknown as Meter);

    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => {
        metrics.recordLifecycleCommand(
          'deletion_requested',
          'completed',
          invalid,
        );
      }).toThrow(TypeError);
      expect(() => {
        metrics.recordControlLedgerReconciliation('agreed', invalid);
      }).toThrow(TypeError);
    }
    expect(add).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
