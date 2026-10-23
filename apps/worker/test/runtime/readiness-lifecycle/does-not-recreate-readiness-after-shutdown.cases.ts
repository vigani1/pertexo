import { expect, it, vi } from 'vitest';
import { WorkerReadinessMonitor } from '../../../src/runtime/health/readiness-monitor.js';

import { type SetReady, logger, marker } from './fixture.js';

export function registerDoesNotRecreateReadinessAfterShutdown(): void {
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
      const monitor = new WorkerReadinessMonitor(readiness, logger, {
        marker: readinessMarker,
      });
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
      expect(readinessMarker.setReady.mock.calls.at(-1)?.[0]?.ready).toBe(
        false,
      );
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
    const setReady = vi.fn<SetReady>(async ({ ready: value }) => {
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
      { marker: { setReady } },
    );
    const checking = monitor.check();
    await writeStarted.promise;

    const stopping = monitor.beforeApplicationShutdown();
    releaseWrite.resolve(undefined);
    await Promise.all([checking, stopping]);

    expect(setReady.mock.calls).toEqual([
      [{ ready: true }],
      [{ ready: false }],
      [{ ready: false }],
    ]);
    expect(ready).toBe(false);
    expect(monitor.status().state).toBe('stopped');
  });

  it('coalesces checks and remains terminal once shutdown starts', async () => {
    const deferred = Promise.withResolvers<undefined>();
    const monitor = new WorkerReadinessMonitor(
      { checkReadiness: vi.fn(() => deferred.promise) },
      logger,
      { marker: marker() },
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
    const setReady = vi.fn(({ ready: value }: Parameters<SetReady>[0]) => {
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
    const monitor = new WorkerReadinessMonitor(readiness, logger, {
      marker: { setReady },
      failClosed: failClosed,
    });
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

  it('revokes readiness and preserves the dependency failure when warning diagnostics throw', async () => {
    const dependencyFailure = new Error('postgres unavailable');
    const readinessMarker = marker();
    readinessMarker.ready = true;
    const monitor = new WorkerReadinessMonitor(
      { checkReadiness: vi.fn().mockRejectedValue(dependencyFailure) },
      {
        ...logger,
        warn: vi.fn(() => {
          throw new Error('warning sink unavailable');
        }),
      },
      { marker: readinessMarker },
    );

    await expect(monitor.check()).rejects.toBe(dependencyFailure);
    expect(readinessMarker.ready).toBe(false);
    expect(readinessMarker.setReady.mock.calls).toContainEqual([
      { ready: false },
    ]);
  });

  it('fails closed without replacing check and marker failures when error diagnostics throw', async () => {
    const dependencyFailure = new Error('postgres unavailable');
    const markerFailure = new Error('marker unavailable');
    const failClosed = vi.fn();
    const monitor = new WorkerReadinessMonitor(
      { checkReadiness: vi.fn().mockRejectedValue(dependencyFailure) },
      {
        ...logger,
        error: vi.fn(() => {
          throw new Error('error sink unavailable');
        }),
      },
      {
        marker: { setReady: vi.fn().mockRejectedValue(markerFailure) },
        failClosed: failClosed,
      },
    );

    await expect(monitor.check()).rejects.toMatchObject({
      errors: [dependencyFailure, markerFailure],
    });
    expect(failClosed).toHaveBeenCalledWith('check', markerFailure);
  });

  it('revokes immediately and bounds shutdown while a dependency probe ignores cancellation', async () => {
    vi.useFakeTimers();
    const probe = Promise.withResolvers<undefined>();
    const readinessMarker = marker();
    readinessMarker.ready = true;
    const monitor = new WorkerReadinessMonitor(
      { checkReadiness: vi.fn(() => probe.promise) },
      logger,
      {
        marker: readinessMarker,
        failClosed: vi.fn(),
        operationTimeoutMillis: 10,
      },
    );
    const checking = monitor.check();
    const observedCheck = checking.catch((error: unknown) => error);
    const stopping = monitor.beforeApplicationShutdown();
    await Promise.resolve();
    await Promise.resolve();

    expect(readinessMarker.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    await expect(stopping).resolves.toBeUndefined();
    expect(monitor.status().state).toBe('stopped');

    probe.resolve(undefined);
    await expect(observedCheck).resolves.toBeInstanceOf(Error);
    expect(readinessMarker.ready).toBe(false);
  });
}
