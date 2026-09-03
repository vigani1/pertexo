import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkerProcessKeepalive } from '../src/runtime/worker-process-keepalive.js';

describe('WorkerProcessKeepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('owns the process-retaining timer for the application lifecycle', () => {
    const keepalive = new WorkerProcessKeepalive();

    keepalive.onApplicationBootstrap();
    expect(vi.getTimerCount()).toBe(1);

    keepalive.beforeApplicationShutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
});
