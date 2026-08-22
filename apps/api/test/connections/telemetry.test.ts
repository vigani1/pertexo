import { describe, expect, it, vi } from 'vitest';

import { createConnectionTelemetry } from '../../src/connections/telemetry.js';

describe('connection telemetry', () => {
  it('records bounded success and failure outcomes without changing command truth', async () => {
    const count = vi.fn();
    const duration = vi.fn();
    const tracedOperations: string[] = [];
    let now = 1_000;
    const telemetry = createConnectionTelemetry({
      count,
      duration,
      trace: <T>(operation: string, work: () => Promise<T>): Promise<T> => {
        tracedOperations.push(operation);
        return work();
      },
      monotonicNow: () => (now += 250),
    });

    await expect(
      telemetry.measure('connection.create', () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
    await expect(
      telemetry.measure('connection.revoke', () =>
        Promise.reject(new Error('failed')),
      ),
    ).rejects.toThrow('failed');
    expect(count.mock.calls).toEqual([
      ['connection.create', 'succeeded'],
      ['connection.revoke', 'failed'],
    ]);
    expect(duration).toHaveBeenCalledTimes(2);
    expect(tracedOperations).toEqual([
      'connection.create',
      'connection.revoke',
    ]);
  });
});
