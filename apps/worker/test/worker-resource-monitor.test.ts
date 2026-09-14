import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';
import { WorkerResourceMonitor } from '../src/runtime/worker-resource-monitor.js';

const config = {
  maximumEventLoopDelayMillis: 200,
  maximumRssBytes: 800,
  sampleIntervalMillis: 5_000,
  unhealthySamplesBeforeDrain: 3,
};

describe('worker resource monitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it.each([
    ['RSS', { eventLoopDelayP99Millis: 200, rssBytes: 801 }],
    ['event-loop delay', { eventLoopDelayP99Millis: 201, rssBytes: 800 }],
  ] as const)(
    'treats equality as healthy and drains for an independently excessive %s sample',
    (_dimension, excessive) => {
      const drainState = new WorkerDrainState();
      const signal = vi.fn();
      const samples = [
        { eventLoopDelayP99Millis: 200, rssBytes: 800 },
        excessive,
      ];
      const monitor = new WorkerResourceMonitor(
        { ...config, unhealthySamplesBeforeDrain: 1 },
        drainState,
        {
          debug: vi.fn(),
          error: vi.fn(),
          fatal: vi.fn(),
          info: vi.fn(),
          trace: vi.fn(),
          warn: vi.fn(),
        },
        { sample: () => samples.shift() ?? excessive, signal },
      );

      monitor.sample();
      expect(drainState.canAcceptWork()).toBe(true);
      monitor.sample();
      expect(drainState.canAcceptWork()).toBe(false);
      expect(signal).toHaveBeenCalledOnce();
    },
  );

  it('signals exactly once even when warning diagnostics throw', () => {
    const drainState = new WorkerDrainState();
    const signal = vi.fn();
    const monitor = new WorkerResourceMonitor(
      { ...config, unhealthySamplesBeforeDrain: 1 },
      drainState,
      {
        debug: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        info: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(() => {
          throw new Error('logger unavailable');
        }),
      },
      {
        sample: () => ({ eventLoopDelayP99Millis: 201, rssBytes: 800 }),
        signal,
      },
    );

    expect(() => {
      monitor.sample();
    }).not.toThrow();
    expect(() => {
      monitor.sample();
    }).not.toThrow();
    expect(drainState.canAcceptWork()).toBe(false);
    expect(signal).toHaveBeenCalledOnce();
  });

  it('contains signal and secondary logger failures after draining admission', () => {
    const drainState = new WorkerDrainState();
    const error = vi.fn(() => {
      throw new Error('secondary logger unavailable');
    });
    const signalFailure = new Error('signal unavailable');
    const monitor = new WorkerResourceMonitor(
      { ...config, unhealthySamplesBeforeDrain: 1 },
      drainState,
      {
        debug: vi.fn(),
        error,
        fatal: vi.fn(),
        info: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(),
      },
      {
        sample: () => ({ eventLoopDelayP99Millis: 201, rssBytes: 800 }),
        signal: () => {
          throw signalFailure;
        },
      },
    );

    expect(() => {
      monitor.sample();
    }).not.toThrow();
    expect(drainState.canAcceptWork()).toBe(false);
    expect(error).toHaveBeenCalledWith(
      'worker.resource_shutdown_signal_failed',
      {},
      signalFailure,
    );
  });

  it('owns one sampling timer across repeated bootstrap and shutdown calls', async () => {
    vi.useFakeTimers();
    const sample = vi.fn(() => ({
      eventLoopDelayP99Millis: 10,
      rssBytes: 700,
    }));
    const monitor = new WorkerResourceMonitor(
      config,
      new WorkerDrainState(),
      {
        debug: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        info: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(),
      },
      { sample, signal: vi.fn() },
    );

    monitor.onApplicationBootstrap();
    monitor.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(config.sampleIntervalMillis);
    expect(sample).toHaveBeenCalledOnce();

    monitor.beforeApplicationShutdown();
    monitor.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(config.sampleIntervalMillis * 2);
    expect(sample).toHaveBeenCalledOnce();
  });
});
