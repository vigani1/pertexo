import type { Meter } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import { createCoordinatorTelemetry } from '../src/execution/coordinator-telemetry.js';

describe('coordinator telemetry', () => {
  it('records schedule-to-start duration and isolates clock skew', () => {
    const add = vi.fn();
    const record = vi.fn();
    const meter = {
      createCounter: vi.fn(() => ({ add })),
      createHistogram: vi.fn(() => ({ record })),
    } as unknown as Meter;
    const telemetry = createCoordinatorTelemetry(meter);

    telemetry.scheduleStarted(4.25);
    telemetry.scheduleStarted(-0.5);
    telemetry.scheduleStarted(Number.NaN);

    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(4.25);
    expect(add.mock.calls).toEqual([
      [1, { outcome: 'observed' }],
      [1, { outcome: 'clock_skew' }],
    ]);
  });
});
