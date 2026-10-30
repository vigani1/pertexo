import type { QueueConsumer } from '@pertexo/queue';
import { expect, it, vi } from 'vitest';
import { runtimeOptions, runtimeDependencies } from './fixture.js';
import { testCoordinatorRuntime } from '../../support/runtime-factories.js';

export function registerAttemptsEverySynchronousRejectedCloserPreserves(): void {
  it('attempts every synchronous or rejected closer and preserves all failures', async () => {
    const failures = {
      consumer: new Error('consumer close failed'),
      due: new Error('due close failed'),
      deadline: new Error('deadline close failed'),
      notifications: new Error('notifications close failed'),
      runStore: new Error('run store close failed'),
      callStore: new Error('call store close failed'),
    };
    const runtime = await testCoordinatorRuntime(runtimeOptions(), {
      callStore: {
        performActions: vi.fn(),
        close: vi.fn().mockRejectedValue(failures.callStore),
      },
      consumerFactory: () => ({
        close: vi.fn(() => {
          throw failures.consumer;
        }),
        isReady: vi.fn().mockReturnValue(true),
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
      }),
      dueWakeupScanner: {
        claimDueWakeups: vi.fn().mockResolvedValue(0),
        close: vi.fn(() => {
          throw failures.due;
        }),
      },
      testSuiteScanner: { scan: vi.fn().mockResolvedValue(0), close: vi.fn() },
      deadlineWakeupScanner: {
        claimDueWakeups: vi.fn().mockResolvedValue(0),
        close: vi.fn().mockRejectedValue(failures.deadline),
      },
      notifications: {
        close: vi.fn(() => {
          throw failures.notifications;
        }),
        publish: vi.fn(),
        resync: vi.fn(),
      },
      runStore: {
        advance: vi.fn(),
        close: vi.fn(() => {
          throw failures.runStore;
        }),
      },
    });
    await runtime.checkReadiness();
    const first = runtime.close();
    expect(runtime.close()).toBe(first);
    const error = await first.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      failures.consumer,
      failures.due,
      failures.deadline,
      failures.notifications,
      failures.runStore,
      failures.callStore,
    ]);
  });

  it('polls due PostgreSQL wakeups without overlap and drains the scanner on close', async () => {
    let releaseScan: (() => void) | undefined;
    const scanStarted = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const scanner = {
      claimDueWakeups: vi
        .fn()
        .mockRejectedValueOnce(new Error('transient database outage'))
        .mockImplementation(async () => scanStarted),
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
    const adapter = { close: vi.fn().mockResolvedValue(undefined) };
    const notifications = {
      ...adapter,
      publish: vi.fn().mockResolvedValue(undefined),
      resync: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = await testCoordinatorRuntime(
      {
        database: {
          connectionString:
            'postgresql://pertexo_app:secret@localhost:5432/pertexo',
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
          max: 5,
          ownerRole: 'pertexo_owner',
        },
        dueWakeupBatchSize: 10,
        dueWakeupPollIntervalMillis: 20,
        maintenanceDatabase: {
          connectionString:
            'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
          max: 2,
          ownerRole: 'pertexo_owner',
        },
        maximumAdmissions: 32,
        redisUrl: 'redis://unreachable.invalid:6379/0',
      },
      {
        consumerFactory: () => consumer,
        notifications,
        runStore: { ...adapter, advance: vi.fn() },
        callStore: { ...adapter, performActions: vi.fn() },
        dueWakeupScanner: scanner,
        testSuiteScanner: {
          scan: vi.fn().mockResolvedValue(0),
          close: vi.fn(),
        },
        deadlineWakeupScanner: {
          claimDueWakeups: vi.fn().mockResolvedValue(0),
          close: vi.fn().mockResolvedValue(undefined),
        },
      },
    );

    await vi.waitFor(() => {
      expect(scanner.claimDueWakeups).toHaveBeenCalledTimes(2);
    });
    const closing = runtime.close();
    expect(scanner.close).not.toHaveBeenCalled();
    releaseScan?.();
    await closing;
    expect(scanner.claimDueWakeups).toHaveBeenCalledTimes(2);
    expect(scanner.close).toHaveBeenCalledOnce();
  });

  it.each(['due', 'deadline'] as const)(
    'aborts an in-flight %s wakeup scan and does not start another scan',
    async (target) => {
      let observedSignal: AbortSignal | undefined;
      const aborted = new Error(`${target} scan aborted`);
      const blockingScanner = {
        claimDueWakeups: vi.fn(
          (_limit: number, signal?: AbortSignal): Promise<number> => {
            observedSignal = signal;
            return new Promise((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => {
                  reject(aborted);
                },
                { once: true },
              );
            });
          },
        ),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const idleScanner = {
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
        runtimeOptions({ backgroundTaskShutdownTimeoutMillis: 100 }),
        runtimeDependencies(
          consumer,
          target === 'due' ? blockingScanner : idleScanner,
          target === 'deadline' ? blockingScanner : idleScanner,
        ),
      );

      await vi.waitFor(() => {
        expect(blockingScanner.claimDueWakeups).toHaveBeenCalledOnce();
      });
      await expect(runtime.close()).resolves.toBeUndefined();
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(observedSignal?.aborted).toBe(true);
      expect(blockingScanner.claimDueWakeups).toHaveBeenCalledOnce();
      expect(blockingScanner.close).toHaveBeenCalledOnce();
      expect(idleScanner.close).toHaveBeenCalledOnce();
      if (target === 'due')
        expect(idleScanner.claimDueWakeups).not.toHaveBeenCalled();
    },
  );
}
