import { vi } from 'vitest';
import type { createTaskProcessPool } from '../../src/process/pool.js';

export function reserveProcess(
  pool: Awaited<ReturnType<typeof createTaskProcessPool>>,
) {
  return vi.waitUntil(() => pool.reserve(), { timeout: 5_000, interval: 20 });
}
