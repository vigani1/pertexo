import { describe, expect, it, vi } from 'vitest';

import { createScheduleTelemetry } from '../../src/schedules/telemetry.js';

describe('schedule telemetry', () => {
  it('records bounded success and failure without changing work truth', async () => {
    const count = vi.fn();
    const duration = vi.fn();
    const telemetry = createScheduleTelemetry({ count, duration });
    const failure = new Error('command failed');

    await expect(
      telemetry.measure('schedule.enable', () => Promise.resolve('enabled')),
    ).resolves.toBe('enabled');
    await expect(
      telemetry.measure('schedule.disable', () => Promise.reject(failure)),
    ).rejects.toBe(failure);

    expect(count.mock.calls).toEqual([
      ['schedule.enable', 'succeeded'],
      ['schedule.disable', 'failed'],
    ]);
    expect(duration).toHaveBeenCalledTimes(2);
    for (const call of duration.mock.calls) {
      expect(call[2]).toBeTypeOf('number');
      expect(call[2]).toBeGreaterThanOrEqual(0);
    }
  });

  it('contains metric failures and runs work exactly once', async () => {
    const count = vi.fn(() => {
      throw new Error('counter unavailable');
    });
    const duration = vi.fn(() => {
      throw new Error('histogram unavailable');
    });
    const telemetry = createScheduleTelemetry({ count, duration });
    const work = vi.fn().mockResolvedValue('committed');

    await expect(telemetry.measure('schedule.enable', work)).resolves.toBe(
      'committed',
    );
    expect(work).toHaveBeenCalledOnce();
    expect(count).toHaveBeenCalledOnce();
    expect(duration).not.toHaveBeenCalled();
  });
});
