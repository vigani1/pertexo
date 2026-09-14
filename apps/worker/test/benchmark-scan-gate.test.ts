import { describe, expect, it, vi } from 'vitest';

import { createBenchmarkScanGate } from './support/benchmark-scan-gate.js';

describe('schedule benchmark scan gate', () => {
  it('releases a blocked scan exactly once', async () => {
    const gate = createBenchmarkScanGate(true);
    let entered = false;
    const waiting = gate.wait().then(() => {
      entered = true;
    });

    await Promise.resolve();
    expect(entered).toBe(false);
    gate.release();
    gate.release();
    await waiting;

    expect(gate.released).toBe(true);
    expect(entered).toBe(true);
  });

  it('rejects with the exact abort reason and removes its listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const reason = new Error('scan stopped');
    const waiting = createBenchmarkScanGate(true).wait(controller.signal);
    const rejected = expect(waiting).rejects.toBe(reason);

    controller.abort(reason);

    await rejected;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('does not block when operation timing is disabled', async () => {
    const gate = createBenchmarkScanGate(false);

    await expect(gate.wait()).resolves.toBeUndefined();
    expect(gate.released).toBe(true);
  });
});
