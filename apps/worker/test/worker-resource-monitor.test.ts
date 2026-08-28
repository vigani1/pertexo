import { describe, expect, it, vi } from 'vitest';

import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';
import { WorkerResourceMonitor } from '../src/runtime/worker-resource-monitor.js';

const config = {
  maximumEventLoopDelayMillis: 200,
  maximumRssBytes: 800,
  sampleIntervalMillis: 5_000,
  unhealthySamplesBeforeDrain: 3,
};

describe('worker resource monitor', () => {
  it('drains and signals only after consecutive unhealthy samples', () => {
    const drainState = new WorkerDrainState();
    const warn = vi.fn();
    const signal = vi.fn();
    const samples = [
      { eventLoopDelayP99Millis: 201, rssBytes: 700 },
      { eventLoopDelayP99Millis: 10, rssBytes: 700 },
      { eventLoopDelayP99Millis: 10, rssBytes: 801 },
      { eventLoopDelayP99Millis: 201, rssBytes: 700 },
      { eventLoopDelayP99Millis: 10, rssBytes: 801 },
    ];
    const monitor = new WorkerResourceMonitor(
      config,
      drainState,
      {
        debug: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        info: vi.fn(),
        trace: vi.fn(),
        warn,
      },
      {
        sample: () => {
          const sample = samples.shift();
          if (sample === undefined) throw new Error('sample fixture exhausted');
          return sample;
        },
        signal,
      },
    );

    for (let index = 0; index < 5; index += 1) monitor.sample();
    monitor.sample();

    expect(drainState.canAcceptWork()).toBe(false);
    expect(signal).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('worker.resource_unhealthy_drain', {
      eventLoopDelayP99Millis: 10,
      rssBytes: 801,
    });
  });
});
