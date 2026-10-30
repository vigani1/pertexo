import type { QueueConsumer } from '@pertexo/queue';
import { expect, it, vi } from 'vitest';
import type { CoordinatorCompositionFactories } from '../../../src/runs/runtime.js';
import { runtimeOptions, runtimeDependencies } from './fixture.js';
import { testCoordinatorRuntime } from '../../support/runtime-factories.js';

export function registerRollsBackEveryOwnerAcquiredBefore(): void {
  it.each([
    ['telemetry', []],
    ['traceRunner', []],
    ['runStore', []],
    ['callStore', ['runStore']],
    ['notifications', ['runStore', 'callStore']],
    ['dueScanner', ['runStore', 'callStore', 'notifications']],
    [
      'deadlineScanner',
      ['runStore', 'callStore', 'notifications', 'dueScanner'],
    ],
    [
      'testSuiteScanner',
      [
        'runStore',
        'callStore',
        'notifications',
        'dueScanner',
        'deadlineScanner',
      ],
    ],
    [
      'consumer',
      [
        'runStore',
        'callStore',
        'notifications',
        'dueScanner',
        'deadlineScanner',
        'testSuiteScanner',
      ],
    ],
  ] as const)(
    'rolls back every owner acquired before %s construction fails',
    async (failedStage, expectedClosed) => {
      const constructionFailure = new Error(`${failedStage} failed`);
      const closed: string[] = [];
      const owned = {
        testSuiteScanner: {
          scan: vi.fn(),
          close: vi.fn(() => {
            closed.push('testSuiteScanner');
            return Promise.resolve();
          }),
        },
        callStore: {
          performActions: vi.fn(),
          close: vi.fn(() => {
            closed.push('callStore');
            return Promise.resolve();
          }),
        },
        runStore: {
          advance: vi.fn(),
          close: vi.fn(() => {
            closed.push('runStore');
            return Promise.resolve();
          }),
        },
        notifications: {
          close: vi.fn(() => {
            closed.push('notifications');
            return Promise.resolve();
          }),
          publish: vi.fn(),
          resync: vi.fn(),
        },
        dueScanner: {
          claimDueWakeups: vi.fn(),
          close: vi.fn(() => {
            closed.push('dueScanner');
            return Promise.resolve();
          }),
        },
        deadlineScanner: {
          claimDueWakeups: vi.fn(),
          close: vi.fn(() => {
            closed.push('deadlineScanner');
            return Promise.resolve();
          }),
        },
      };
      const acquire = <T>(stage: string, value: T): T => {
        if (stage === failedStage) throw constructionFailure;
        return value;
      };
      const factories = {
        consumer: vi.fn(() =>
          acquire('consumer', {
            close: vi.fn(),
            isReady: vi.fn(),
            waitUntilReady: vi.fn(),
          }),
        ),
        testSuiteScanner: vi.fn(() =>
          Promise.resolve(acquire('testSuiteScanner', owned.testSuiteScanner)),
        ),
        deadlineScanner: vi.fn(() =>
          acquire('deadlineScanner', owned.deadlineScanner),
        ),
        dueScanner: vi.fn(() => acquire('dueScanner', owned.dueScanner)),
        notifications: vi.fn(() =>
          acquire('notifications', owned.notifications),
        ),
        runStore: vi.fn(() => acquire('runStore', owned.runStore)),
        callStore: vi.fn(() => acquire('callStore', owned.callStore)),
        telemetry: vi.fn(() => acquire('telemetry', {})),
        traceRunner: vi.fn(() => acquire('traceRunner', {})),
      } as unknown as CoordinatorCompositionFactories;

      await expect(
        testCoordinatorRuntime(runtimeOptions(), {}, factories),
      ).rejects.toBe(constructionFailure);
      expect(new Set(closed)).toEqual(new Set(expectedClosed));
      expect(closed).toHaveLength(expectedClosed.length);
    },
  );

  it('waits for the first complete scan and remains terminal after close', async () => {
    const dueScan = Promise.withResolvers<number>();
    const due = {
      claimDueWakeups: vi.fn(() => dueScan.promise),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const deadline = {
      claimDueWakeups: vi.fn().mockResolvedValue(0),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const consumer = {
      close: vi
        .fn<NonNullable<QueueConsumer['close']>>()
        .mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi
        .fn<NonNullable<QueueConsumer['isReady']>>()
        .mockReturnValue(true),
      waitUntilReady: vi
        .fn<NonNullable<QueueConsumer['waitUntilReady']>>()
        .mockResolvedValue(undefined),
    } satisfies QueueConsumer;
    const runtime = await testCoordinatorRuntime(
      runtimeOptions(),
      runtimeDependencies(consumer, due, deadline),
    );
    let readySettled = false;
    const readiness = runtime.checkReadiness().finally(() => {
      readySettled = true;
    });
    await Promise.resolve();
    expect(readySettled).toBe(false);

    dueScan.resolve(0);
    await expect(readiness).resolves.toBeUndefined();
    expect(deadline.claimDueWakeups).toHaveBeenCalledOnce();
    await runtime.close();
    await expect(runtime.checkReadiness()).rejects.toThrow(/closed/u);
  });

  it('recovers scanner health even when failure diagnostics throw', async () => {
    const scanFailure = new Error('postgres unavailable');
    const due = {
      claimDueWakeups: vi
        .fn()
        .mockRejectedValueOnce(scanFailure)
        .mockResolvedValue(0),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const deadline = {
      claimDueWakeups: vi.fn().mockResolvedValue(0),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const consumer = {
      close: vi
        .fn<NonNullable<QueueConsumer['close']>>()
        .mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi
        .fn<NonNullable<QueueConsumer['isReady']>>()
        .mockReturnValue(true),
      waitUntilReady: vi
        .fn<NonNullable<QueueConsumer['waitUntilReady']>>()
        .mockResolvedValue(undefined),
    } satisfies QueueConsumer;
    const logger = {
      debug: vi.fn(),
      error: vi.fn(() => {
        throw new Error('logger unavailable');
      }),
      fatal: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    };
    const runtime = await testCoordinatorRuntime(
      runtimeOptions({ dueWakeupPollIntervalMillis: 10 }),
      { ...runtimeDependencies(consumer, due, deadline), logger },
    );

    await expect(runtime.checkReadiness()).rejects.toThrow(/latest scan/u);
    await vi.waitFor(() => {
      expect(due.claimDueWakeups.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await expect(runtime.checkReadiness()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'coordinator.wakeup_scan_failed',
      { safeErrorCode: 'coordinator.wakeup_scan_failed' },
      scanFailure,
    );
    await runtime.close();
  });
}
