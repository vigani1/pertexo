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

  it('keeps one timer across repeated bootstrap and removes it once', () => {
    const keepalive = new WorkerProcessKeepalive();

    keepalive.onApplicationBootstrap();
    keepalive.onApplicationBootstrap();
    expect(vi.getTimerCount()).toBe(1);

    keepalive.beforeApplicationShutdown();
    keepalive.beforeApplicationShutdown();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows shutdown before bootstrap without creating a timer', () => {
    const keepalive = new WorkerProcessKeepalive();

    keepalive.beforeApplicationShutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
});
