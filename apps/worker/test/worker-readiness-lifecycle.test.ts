import { describe, expect, it, vi } from 'vitest';

import {
  WorkerReadinessMonitor,
  type WorkerReadinessMarker,
} from '../src/runtime/worker-readiness-monitor.js';
import { WorkerReadiness } from '../src/runtime/worker-readiness.js';
import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};

function marker(): WorkerReadinessMarker & {
  ready: boolean;
  setReady: ReturnType<typeof vi.fn<(ready: boolean) => Promise<void>>>;
} {
  const state = {
    ready: false,
    setReady: vi.fn<(ready: boolean) => Promise<void>>((ready) => {
      state.ready = ready;
      return Promise.resolve();
    }),
  };
  return state;
}

describe('worker readiness lifecycle', () => {
  it.each(['success', 'failure'] as const)(
    'does not recreate readiness after shutdown during deferred %s',
    async (outcome) => {
      const deferred = Promise.withResolvers<undefined>();
      const readiness = {
        checkReadiness: vi.fn(() =>
          deferred.promise.then(() => {
            if (outcome === 'failure') throw new Error('not ready');
          }),
        ),
      };
      const readinessMarker = marker();
      const monitor = new WorkerReadinessMonitor(
        readiness,
        logger,
        readinessMarker,
      );
      const checking = monitor.check();

      expect(monitor.status()).toMatchObject({
        state: 'checking',
        checkInFlight: true,
      });
      const stopping = monitor.beforeApplicationShutdown();
      expect(monitor.status()).toMatchObject({ state: 'stopping' });
      deferred.resolve(undefined);
      await checking.catch(() => undefined);
      await stopping;

      expect(readinessMarker.ready).toBe(false);
      expect(readinessMarker.setReady.mock.calls.at(-1)?.[0]).toBe(false);
      expect(monitor.status()).toEqual({
        state: 'stopped',
        checkInFlight: false,
        scheduled: false,
      });
      await expect(
        monitor.beforeApplicationShutdown(),
      ).resolves.toBeUndefined();
    },
  );

  it('orders final removal after an in-flight marker write', async () => {
    const writeStarted = Promise.withResolvers<undefined>();
    const releaseWrite = Promise.withResolvers<undefined>();
    let ready = false;
    const setReady = vi.fn<(value: boolean) => Promise<void>>(async (value) => {
      if (value) {
        writeStarted.resolve(undefined);
        await releaseWrite.promise;
      }
      ready = value;
    });
    const monitor = new WorkerReadinessMonitor(
      {
        checkReadiness: vi.fn().mockResolvedValue(undefined),
      },
      logger,
      { setReady },
    );
    const checking = monitor.check();
    await writeStarted.promise;

    const stopping = monitor.beforeApplicationShutdown();
    releaseWrite.resolve(undefined);
    await Promise.all([checking, stopping]);

    expect(setReady.mock.calls).toEqual([[true], [false]]);
    expect(ready).toBe(false);
    expect(monitor.status().state).toBe('stopped');
  });

  it('coalesces checks and remains terminal once shutdown starts', async () => {
    const deferred = Promise.withResolvers<undefined>();
    const monitor = new WorkerReadinessMonitor(
      { checkReadiness: vi.fn(() => deferred.promise) },
      logger,
      marker(),
    );
    const checking = monitor.check();

    expect(monitor.check()).toBe(checking);
    const stopping = monitor.beforeApplicationShutdown();
    await expect(monitor.check()).resolves.toBeUndefined();
    deferred.resolve(undefined);
    await Promise.all([checking, stopping]);

    monitor.start();
    expect(monitor.status()).toEqual({
      state: 'stopped',
      checkInFlight: false,
      scheduled: false,
    });
  });

  it('preserves dependency and marker-revocation failures and fails the process closed', async () => {
    const dependencyFailure = new Error('postgres unavailable');
    const markerFailure = new Error('readiness marker removal failed');
    let ready = false;
    const setReady = vi.fn((value: boolean) => {
      if (!value) return Promise.reject(markerFailure);
      ready = true;
      return Promise.resolve();
    });
    const failClosed = vi.fn();
    const readiness = {
      checkReadiness: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(dependencyFailure),
    };
    const monitor = new WorkerReadinessMonitor(
      readiness,
      logger,
      { setReady },
      failClosed,
    );
    await monitor.check();
    expect(ready).toBe(true);

    await expect(monitor.check()).rejects.toMatchObject({
      errors: [dependencyFailure, markerFailure],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'worker.readiness_check_failed',
      {},
      dependencyFailure,
    );
    expect(logger.error).toHaveBeenCalledWith(
      'worker.readiness_revocation_failed',
      { phase: 'check' },
      markerFailure,
    );
    expect(failClosed).toHaveBeenCalledWith('check', markerFailure);
  });

  it('finishes shutdown and permits sibling cleanup when marker removal fails', async () => {
    const markerFailure = new Error('readiness marker removal failed');
    const siblingClose = vi.fn().mockResolvedValue(undefined);
    const failClosed = vi.fn();
    const monitor = new WorkerReadinessMonitor(
      { checkReadiness: vi.fn().mockResolvedValue(undefined) },
      logger,
      {
        setReady: vi.fn((ready: boolean) =>
          ready ? Promise.resolve() : Promise.reject(markerFailure),
        ),
      },
      failClosed,
    );
    await monitor.check();

    await expect(
      Promise.all([monitor.beforeApplicationShutdown(), siblingClose()]),
    ).resolves.toEqual([undefined, undefined]);
    expect(siblingClose).toHaveBeenCalledOnce();
    expect(monitor.status()).toEqual({
      state: 'stopped',
      checkInFlight: false,
      scheduled: false,
    });
    expect(logger.error).toHaveBeenCalledWith(
      'worker.readiness_revocation_failed',
      { phase: 'shutdown' },
      markerFailure,
    );
    expect(failClosed).toHaveBeenCalledWith('shutdown', markerFailure);
  });

  it('rejects readiness when draining begins during dependency checks', async () => {
    const deferred = Promise.withResolvers<undefined>();
    const drain = new WorkerDrainState();
    const readiness = new WorkerReadiness(
      { checkReadiness: () => deferred.promise } as never,
      { checkReadiness: vi.fn().mockResolvedValue(undefined) } as never,
      drain,
      undefined,
      undefined,
    );
    const checking = readiness.checkReadiness();

    drain.beginDrain();
    deferred.resolve(undefined);

    await expect(checking).rejects.toThrow('worker is draining');
  });
});
