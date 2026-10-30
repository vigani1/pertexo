import type { ScheduleTriggerScanner } from '@pertexo/database/testing';

import { expect, it, vi } from 'vitest';

import type { TriggerCompositionFactories } from '../../../src/triggers/runtime.js';
import { dependencies, options } from './fixture.js';
import { testTriggerRuntime } from '../../support/runtime-factories.js';

export function registerRollsBackOwnersAcquiredBeforeS(): void {
  it.each([
    ['telemetry', []],
    ['traceRunner', []],
    ['reconciliation', []],
    ['scanner', ['reconciliation']],
    ['coordination', ['reconciliation', 'scanner']],
    ['consumer', ['reconciliation', 'scanner', 'coordination']],
  ] as const)(
    'rolls back owners acquired before %s construction fails',
    async (failedStage, expectedClosed) => {
      const failure = new Error(`${failedStage} failed`);
      const closed: string[] = [];
      const reconciliation = {
        close: vi.fn(() => {
          closed.push('reconciliation');
          return Promise.resolve();
        }),
        reconcile: vi.fn(),
        recordFailure: vi.fn(),
      };
      const scanner = {
        close: vi.fn(() => {
          closed.push('scanner');
          return Promise.resolve();
        }),
        scanDue: vi.fn(),
      };
      const acquire = <T>(stage: string, value: T): T => {
        if (stage === failedStage) throw failure;
        return value;
      };
      const factories = {
        coordination: vi.fn(() =>
          acquire('coordination', {
            close: vi.fn(() => {
              closed.push('coordination');
              return Promise.resolve();
            }),
            scanDue: vi.fn(),
          }),
        ),
        consumer: vi.fn(() =>
          acquire('consumer', {
            close: vi.fn(),
            isReady: vi.fn(),
            waitUntilReady: vi.fn(),
          }),
        ),
        reconciliation: vi.fn(() => acquire('reconciliation', reconciliation)),
        scanner: vi.fn(() => acquire('scanner', scanner)),
        telemetry: vi.fn(() => acquire('telemetry', {})),
        traceRunner: vi.fn(() => acquire('traceRunner', {})),
      } as unknown as TriggerCompositionFactories;

      await expect(
        testTriggerRuntime(
          options,
          {
            checkpointFactory: () => ({
              checkpoint: {},
            }),
          },
          factories,
        ),
      ).rejects.toBe(failure);
      expect(new Set(closed)).toEqual(new Set(expectedClosed));
      expect(closed).toHaveLength(expectedClosed.length);
    },
  );

  it('waits for its first scan, never overlaps scans, and stays closed', async () => {
    vi.useFakeTimers();
    try {
      const selected = dependencies();
      const firstScan = Promise.withResolvers<{
        claimed: number;
        accepted: number;
        skipped: number;
        paused: number;
        deferred: number;
        maxLagSeconds: number;
      }>();
      let active = 0;
      let maximumActive = 0;
      vi.mocked(selected.scanner.scanDue).mockImplementation(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await firstScan.promise;
        } finally {
          active -= 1;
        }
      });
      const runtime = await testTriggerRuntime(
        { ...options, pollIntervalMillis: 10 },
        {
          ...selected,
          checkpointFactory: () => ({ checkpoint: {} }),
        },
      );
      let readinessSettled = false;
      const readiness = runtime.checkReadiness().finally(() => {
        readinessSettled = true;
      });
      await vi.waitFor(() => {
        expect(selected.scanner.scanDue).toHaveBeenCalledOnce();
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(readinessSettled).toBe(false);
      expect(selected.scanner.scanDue).toHaveBeenCalledOnce();
      expect(maximumActive).toBe(1);

      firstScan.resolve({
        claimed: 0,
        accepted: 0,
        skipped: 0,
        paused: 0,
        deferred: 0,
        maxLagSeconds: 0,
      });
      await readiness;
      await runtime.close();
      await expect(runtime.checkReadiness()).rejects.toThrow(/closed/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues after hostile failure logging and recovers readiness', async () => {
    const selected = dependencies();
    const failure = new Error('postgres unavailable');
    vi.mocked(selected.scanner.scanDue)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({
        claimed: 0,
        accepted: 0,
        skipped: 0,
        paused: 0,
        deferred: 0,
        maxLagSeconds: 0,
      });
    selected.logger.error.mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    const runtime = await testTriggerRuntime(
      { ...options, pollIntervalMillis: 10 },
      {
        ...selected,
        checkpointFactory: () => ({ checkpoint: {} }),
      },
    );

    await expect(runtime.checkReadiness()).rejects.toThrow(/latest scan/u);
    await vi.waitFor(() => {
      expect(
        vi.mocked(selected.scanner.scanDue).mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
    });
    await expect(runtime.checkReadiness()).resolves.toBeUndefined();
    expect(selected.logger.error).toHaveBeenCalledWith(
      'trigger.scan_failed',
      { safeErrorCode: 'trigger.scan_failed' },
      expect.objectContaining({ errors: [failure] }),
    );
    await runtime.close();
  });

  it('bounds shutdown and defers adapters until an ignored scan settles', async () => {
    const selected = dependencies();
    const scan =
      Promise.withResolvers<
        Awaited<ReturnType<ScheduleTriggerScanner['scanDue']>>
      >();
    vi.mocked(selected.scanner.scanDue).mockReturnValue(scan.promise);
    const runtime = await testTriggerRuntime(
      { ...options, backgroundTaskShutdownTimeoutMillis: 5 },
      {
        ...selected,
        checkpointFactory: () => ({ checkpoint: {} }),
      },
    );
    await vi.waitFor(() => {
      expect(selected.scanner.scanDue).toHaveBeenCalledOnce();
    });
    const first = runtime.close();
    expect(runtime.close()).toBe(first);
    await expect(first).rejects.toMatchObject({
      name: 'BackgroundTaskShutdownTimeoutError',
    });
    expect(selected.scanner.close).not.toHaveBeenCalled();
    expect(selected.reconciliation.close).not.toHaveBeenCalled();

    scan.resolve({
      claimed: 0,
      accepted: 0,
      skipped: 0,
      paused: 0,
      deferred: 0,
      maxLagSeconds: 0,
    });
    await vi.waitFor(() => {
      expect(selected.scanner.close).toHaveBeenCalledOnce();
      expect(selected.reconciliation.close).toHaveBeenCalledOnce();
    });
  });
}
