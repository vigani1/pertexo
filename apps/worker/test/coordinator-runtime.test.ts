import type {
  CoordinatorRunStore,
  PublishedWorkflowReader,
} from '@pertexo/database/testing';
import { CoordinatorDeliveryMismatchError } from '@pertexo/database/testing';
import {
  JOB_NAME,
  QUEUE_NAME,
  type QueueConsumer,
  type QueueConsumerOptions,
} from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/unbound-method -- assertions target injected seam fakes */

import {
  createCoordinatorRuntime,
  type CoordinatorCompositionFactories,
  type CoordinatorRuntimeOptions,
} from '../src/execution/coordinator-runtime.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const VERSION_ID = '33333333-3333-4333-8333-333333333333';
const OUTBOX_EVENT_ID = '44444444-4444-4444-8444-444444444444';
type RuntimeDependencies = NonNullable<
  Parameters<typeof createCoordinatorRuntime>[1]
>;

function runtimeOptions(
  overrides: Partial<CoordinatorRuntimeOptions> = {},
): CoordinatorRuntimeOptions {
  return {
    database: {
      connectionString:
        'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 5,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    },
    maximumAdmissions: 32,
    redisUrl: 'redis://unreachable.invalid:6379/0',
    ...overrides,
  };
}

function runtimeDependencies(
  consumer: QueueConsumer,
  dueWakeupScanner: NonNullable<RuntimeDependencies['dueWakeupScanner']>,
  deadlineWakeupScanner: NonNullable<
    RuntimeDependencies['deadlineWakeupScanner']
  >,
): RuntimeDependencies {
  return {
    consumerFactory: () => consumer,
    engine: { advance: vi.fn() },
    notifications: {
      close: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn(),
      resync: vi.fn(),
    },
    reader: { close: vi.fn(), readForExecution: vi.fn() },
    runStore: {
      acknowledgeAdvanceDelivery: vi.fn(),
      close: vi.fn(),
      commitAdvancePlan: vi.fn(),
      loadAdvanceState: vi.fn(),
    },
    dueWakeupScanner,
    deadlineWakeupScanner,
  };
}

describe('coordinator runtime', () => {
  it.each([
    ['telemetry', []],
    ['traceRunner', []],
    ['runStore', []],
    ['reader', ['runStore']],
    ['notifications', ['runStore', 'reader']],
    ['dueScanner', ['runStore', 'reader', 'notifications']],
    ['deadlineScanner', ['runStore', 'reader', 'notifications', 'dueScanner']],
    [
      'consumer',
      ['runStore', 'reader', 'notifications', 'dueScanner', 'deadlineScanner'],
    ],
  ] as const)(
    'rolls back every owner acquired before %s construction fails',
    async (failedStage, expectedClosed) => {
      const constructionFailure = new Error(`${failedStage} failed`);
      const closed: string[] = [];
      const owned = {
        runStore: {
          acknowledgeAdvanceDelivery: vi.fn(),
          close: vi.fn(() => {
            closed.push('runStore');
            return Promise.resolve();
          }),
          commitAdvancePlan: vi.fn(),
          loadAdvanceState: vi.fn(),
        },
        reader: {
          close: vi.fn(() => {
            closed.push('reader');
            return Promise.resolve();
          }),
          readForExecution: vi.fn(),
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
        deadlineScanner: vi.fn(() =>
          acquire('deadlineScanner', owned.deadlineScanner),
        ),
        dueScanner: vi.fn(() => acquire('dueScanner', owned.dueScanner)),
        notifications: vi.fn(() =>
          acquire('notifications', owned.notifications),
        ),
        reader: vi.fn(() => acquire('reader', owned.reader)),
        runStore: vi.fn(() => acquire('runStore', owned.runStore)),
        telemetry: vi.fn(() => acquire('telemetry', {})),
        traceRunner: vi.fn(() => acquire('traceRunner', {})),
      } as unknown as CoordinatorCompositionFactories;

      await expect(
        createCoordinatorRuntime(
          runtimeOptions(),
          { engine: { advance: vi.fn() } },
          factories,
        ),
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
    const consumer: QueueConsumer = {
      close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi.fn().mockReturnValue(true),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = await createCoordinatorRuntime(
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
    const consumer: QueueConsumer = {
      close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi.fn().mockReturnValue(true),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
    };
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
    const runtime = await createCoordinatorRuntime(
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

  it('attempts every synchronous or rejected closer and preserves all failures', async () => {
    const failures = {
      consumer: new Error('consumer close failed'),
      due: new Error('due close failed'),
      deadline: new Error('deadline close failed'),
      notifications: new Error('notifications close failed'),
      reader: new Error('reader close failed'),
      runStore: new Error('run store close failed'),
    };
    const runtime = await createCoordinatorRuntime(runtimeOptions(), {
      consumerFactory: () => ({
        close: vi.fn(() => {
          throw failures.consumer;
        }),
        isReady: vi.fn().mockReturnValue(true),
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
      }),
      engine: { advance: vi.fn() },
      dueWakeupScanner: {
        claimDueWakeups: vi.fn().mockResolvedValue(0),
        close: vi.fn(() => {
          throw failures.due;
        }),
      },
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
      reader: {
        close: vi.fn().mockRejectedValue(failures.reader),
        readForExecution: vi.fn(),
      },
      runStore: {
        acknowledgeAdvanceDelivery: vi.fn(),
        close: vi.fn(() => {
          throw failures.runStore;
        }),
        commitAdvancePlan: vi.fn(),
        loadAdvanceState: vi.fn(),
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
      failures.reader,
      failures.runStore,
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
    const consumer: QueueConsumer = {
      close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi.fn().mockReturnValue(true),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = { close: vi.fn().mockResolvedValue(undefined) };
    const notifications = {
      ...adapter,
      publish: vi.fn().mockResolvedValue(undefined),
      resync: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = await createCoordinatorRuntime(
      {
        database: {
          connectionString:
            'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
          max: 5,
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        },
        dueWakeupBatchSize: 10,
        dueWakeupPollIntervalMillis: 20,
        maximumAdmissions: 32,
        redisUrl: 'redis://unreachable.invalid:6379/0',
      },
      {
        consumerFactory: () => consumer,
        engine: { advance: vi.fn() },
        notifications,
        reader: { ...adapter, readForExecution: vi.fn() },
        runStore: {
          ...adapter,
          acknowledgeAdvanceDelivery: vi.fn(),
          loadAdvanceState: vi.fn(),
          commitAdvancePlan: vi.fn(),
        },
        dueWakeupScanner: scanner,
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
      const consumer: QueueConsumer = {
        close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
        isReady: vi.fn().mockReturnValue(true),
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
      };
      const runtime = await createCoordinatorRuntime(
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

  it('reports a bounded shutdown failure and defers adapters until raw scanning settles', async () => {
    const scan = Promise.withResolvers<number>();
    const blockingScanner = {
      claimDueWakeups: vi.fn(() => scan.promise),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const idleScanner = {
      claimDueWakeups: vi.fn().mockResolvedValue(0),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const consumer: QueueConsumer = {
      close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi.fn().mockReturnValue(true),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = await createCoordinatorRuntime(
      runtimeOptions({ backgroundTaskShutdownTimeoutMillis: 5 }),
      runtimeDependencies(consumer, blockingScanner, idleScanner),
    );

    await vi.waitFor(() => {
      expect(blockingScanner.claimDueWakeups).toHaveBeenCalledOnce();
    });
    await expect(runtime.close()).rejects.toMatchObject({
      name: 'BackgroundTaskShutdownTimeoutError',
    });
    expect(blockingScanner.close).not.toHaveBeenCalled();
    expect(idleScanner.close).not.toHaveBeenCalled();

    scan.resolve(0);
    await vi.waitFor(() => {
      expect(blockingScanner.close).toHaveBeenCalledOnce();
      expect(idleScanner.close).toHaveBeenCalledOnce();
    });
  });

  it('composes one traced coordinator consumer and closes every owned adapter', async () => {
    let consumerOptions: QueueConsumerOptions | undefined;
    const consumer: QueueConsumer = {
      close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi.fn().mockReturnValue(true),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
    };
    const runStore: CoordinatorRunStore = {
      acknowledgeAdvanceDelivery: vi.fn().mockResolvedValue({
        kind: 'acknowledged',
      }),
      close: vi.fn().mockResolvedValue(undefined),
      loadAdvanceState: vi.fn().mockResolvedValue({
        kind: 'ready',
        state: {
          runId: RUN_ID,
          workflowVersionId: VERSION_ID,
          checkpoint: {},
          observations: [],
        },
      }),
      commitAdvancePlan: vi.fn().mockResolvedValue({
        kind: 'committed',
        revision: 1,
        admittedAttempts: [],
      }),
    };
    const reader: PublishedWorkflowReader = {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn().mockResolvedValue({
        kind: 'v2_projection',
        workflowVersion: {
          id: VERSION_ID,
          workspaceId: WORKSPACE_ID,
          workflowId: '55555555-5555-4555-8555-555555555555',
          versionNumber: 1,
          schemaVersion: 1,
          checksum:
            'wf:v2:sha256:1111111111111111111111111111111111111111111111111111111111111111',
          executableSchemaVersion: 2,
          executableJson: {},
          compatibilityReleaseEpoch: 1,
        },
      }),
    };
    const runtime = await createCoordinatorRuntime(
      {
        database: {
          connectionString:
            'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
          max: 5,
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        },
        maximumAdmissions: 32,
        redisUrl: 'redis://unreachable.invalid:6379/0',
      },
      {
        consumerFactory: (options): QueueConsumer => {
          consumerOptions = options;
          return consumer;
        },
        engine: {
          advance: vi.fn().mockResolvedValue({
            kind: 'no_change',
            revision: 0,
          }),
        },
        dueWakeupScanner: {
          claimDueWakeups: vi.fn().mockResolvedValue(0),
          close: vi.fn().mockResolvedValue(undefined),
        },
        deadlineWakeupScanner: {
          claimDueWakeups: vi.fn().mockResolvedValue(0),
          close: vi.fn().mockResolvedValue(undefined),
        },
        reader,
        runStore,
      },
    );

    expect(consumerOptions).toMatchObject({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://unreachable.invalid:6379/0',
    });
    expect(consumerOptions?.traceRunner).toBeDefined();
    await expect(
      consumerOptions?.handler({ name: 'unsupported-delivery' } as never, {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: 'InvalidQueueDeliveryError' });
    await expect(
      consumerOptions?.handler(
        {
          name: JOB_NAME.advanceWorkflowRun,
          data: {
            schemaVersion: 1,
            workspaceId: WORKSPACE_ID,
            runId: RUN_ID,
            outboxEventId: OUTBOX_EVENT_ID,
          },
          transport: { attemptsMade: 0, jobId: `outbox-${OUTBOX_EVENT_ID}` },
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();
    vi.mocked(runStore.acknowledgeAdvanceDelivery).mockRejectedValueOnce(
      new CoordinatorDeliveryMismatchError(),
    );
    await expect(
      consumerOptions?.handler(
        {
          name: JOB_NAME.advanceWorkflowRun,
          data: {
            schemaVersion: 1,
            workspaceId: WORKSPACE_ID,
            runId: RUN_ID,
            outboxEventId: OUTBOX_EVENT_ID,
          },
          transport: { attemptsMade: 0, jobId: `outbox-${OUTBOX_EVENT_ID}` },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ name: 'UnrecoverableError' });

    await runtime.close();
    await runtime.close();
    expect(consumer.close).toHaveBeenCalledOnce();
    expect(reader.close).toHaveBeenCalledOnce();
    expect(runStore.close).toHaveBeenCalledOnce();
  });
});
