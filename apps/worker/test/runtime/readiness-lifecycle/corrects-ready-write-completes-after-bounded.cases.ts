import { expect, it, vi } from 'vitest';
import { WorkerReadinessMonitor } from '../../../src/runtime/health/readiness-monitor.js';
import { WorkerReadiness } from '../../../src/runtime/health/readiness.js';
import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import { type SetReady, logger, idleRuntime } from './fixture.js';

export function registerCorrectsReadyWriteCompletesAfterBounded(): void {
  it('corrects a ready write that completes after bounded shutdown', async () => {
    vi.useFakeTimers();
    const readyWriteStarted = Promise.withResolvers<undefined>();
    const releaseReadyWrite = Promise.withResolvers<undefined>();
    let ready = false;
    const setReady = vi.fn(
      async ({ ready: value }: Parameters<SetReady>[0]) => {
        if (value) {
          readyWriteStarted.resolve(undefined);
          await releaseReadyWrite.promise;
        }
        ready = value;
      },
    );
    const monitor = new WorkerReadinessMonitor(
      { checkReadiness: vi.fn().mockResolvedValue(undefined) },
      logger,
      { marker: { setReady }, failClosed: vi.fn(), operationTimeoutMillis: 10 },
    );
    const checking = monitor.check();
    const observedCheck = checking.catch((error: unknown) => error);
    await readyWriteStarted.promise;

    const stopping = monitor.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
    expect(ready).toBe(false);

    releaseReadyWrite.resolve(undefined);
    await observedCheck;
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    expect(ready).toBe(false);
    expect(setReady.mock.calls.at(-1)?.[0]?.ready).toBe(false);
  });

  it('bounds a hung shutdown revocation and reports fail-closed state', async () => {
    vi.useFakeTimers();
    const revocation = Promise.withResolvers<undefined>();
    const failClosed = vi.fn();
    const monitor = new WorkerReadinessMonitor(
      { checkReadiness: vi.fn().mockResolvedValue(undefined) },
      logger,
      {
        marker: {
          setReady: vi.fn(({ ready }: Parameters<SetReady>[0]) =>
            ready ? Promise.resolve() : revocation.promise,
          ),
        },
        failClosed: failClosed,
        operationTimeoutMillis: 10,
      },
    );

    const stopping = monitor.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(10);
    await expect(stopping).resolves.toBeUndefined();
    expect(monitor.status().state).toBe('stopped');
    expect(failClosed).toHaveBeenCalledWith(
      'shutdown',
      expect.objectContaining({ name: 'BackgroundTaskShutdownTimeoutError' }),
    );
    revocation.resolve(undefined);
  });

  it('finishes shutdown and permits sibling cleanup when marker removal fails', async () => {
    const markerFailure = new Error('readiness marker removal failed');
    const siblingClose = vi.fn().mockResolvedValue(undefined);
    const failClosed = vi.fn();
    const monitor = new WorkerReadinessMonitor(
      { checkReadiness: vi.fn().mockResolvedValue(undefined) },
      logger,
      {
        marker: {
          setReady: vi.fn(({ ready }: Parameters<SetReady>[0]) =>
            ready ? Promise.resolve() : Promise.reject(markerFailure),
          ),
        },
        failClosed: failClosed,
      },
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
      idleRuntime(),
      idleRuntime(),
      idleRuntime(),
      idleRuntime(),
      idleRuntime(),
      idleRuntime(),
      idleRuntime(),
    );
    const checking = readiness.checkReadiness();

    drain.beginDrain();
    deferred.resolve(undefined);

    await expect(checking).rejects.toThrow('worker is draining');
  });

  it('includes the health of every runtime', async () => {
    const checks = Array.from({ length: 9 }, () =>
      vi.fn().mockResolvedValue(undefined),
    );
    const readiness = new WorkerReadiness(
      { checkReadiness: checks[0] } as never,
      { checkReadiness: checks[1] } as never,
      new WorkerDrainState(),
      { checkReadiness: checks[2] } as never,
      { checkReadiness: checks[3] } as never,
      { checkReadiness: checks[4] } as never,
      { checkReadiness: checks[5] } as never,
      { checkReadiness: checks[6] } as never,
      { checkReadiness: checks[7] } as never,
      { checkReadiness: checks[8] } as never,
    );

    await expect(readiness.checkReadiness()).resolves.toBeUndefined();
    for (const check of checks) expect(check).toHaveBeenCalledOnce();
  });

  it('refuses readiness when authentication mail delivery is degraded', async () => {
    const mail = {
      checkReadiness: vi.fn(() => {
        throw new Error('mail unavailable');
      }),
    };
    const readiness = new WorkerReadiness(
      { checkReadiness: vi.fn().mockResolvedValue(undefined) } as never,
      { checkReadiness: vi.fn().mockResolvedValue(undefined) } as never,
      new WorkerDrainState(),
      idleRuntime(),
      idleRuntime(),
      idleRuntime(),
      idleRuntime(),
      idleRuntime(),
      idleRuntime(),
      mail as never,
    );
    await expect(readiness.checkReadiness()).rejects.toThrow(
      'mail unavailable',
    );
  });
}
