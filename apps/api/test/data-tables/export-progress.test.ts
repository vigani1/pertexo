import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchExportProgress } from '../../src/data-tables/export/progress.js';
import { exportBudgetMillis } from '../../src/data-tables/export/limits.js';

beforeEach(() =>
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] }),
);
afterEach(() => vi.useRealTimers());
it('aborts once after 60 seconds without socket write progress', async () => {
  const response = { socket: { bytesWritten: 10 } };
  const stalled = vi.fn();
  const stop = watchExportProgress(response, stalled);
  await vi.advanceTimersByTimeAsync(59_000);
  expect(stalled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(stalled).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(stalled).toHaveBeenCalledOnce();
  stop();
});
it('resets only on socket writes and stops observing completed downloads', async () => {
  const response = { socket: { bytesWritten: 10 } };
  const stalled = vi.fn();
  const stop = watchExportProgress(response, stalled);
  await vi.advanceTimersByTimeAsync(50_000);
  response.socket.bytesWritten += 100;
  await vi.advanceTimersByTimeAsync(50_000);
  expect(stalled).not.toHaveBeenCalled();
  stop();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(stalled).not.toHaveBeenCalled();
});
it('budgets one minute plus one second per stored MiB, capped at five minutes', () => {
  expect(exportBudgetMillis({ storedBytes: 0 })).toBe(60_000);
  expect(exportBudgetMillis({ storedBytes: 50 * 1_048_576 })).toBe(110_000);
  expect(exportBudgetMillis({ storedBytes: 1_073_741_824 })).toBe(300_000);
});
