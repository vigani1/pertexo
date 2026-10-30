import type { RunAdvanceStore } from '@pertexo/database/testing';
import { CoordinatorDeliveryMismatchError } from '@pertexo/database/testing';
import {
  JOB_NAME,
  QUEUE_NAME,
  type QueueConsumer,
  type QueueConsumerOptions,
} from '@pertexo/queue';
import { expect, it, vi } from 'vitest';
import {
  WORKSPACE_ID,
  RUN_ID,
  OUTBOX_EVENT_ID,
  runtimeOptions,
  runtimeDependencies,
} from './fixture.js';
import { testCoordinatorRuntime } from '../../support/runtime-factories.js';

export function registerReportsBoundedShutdownFailureDefersAdapters(): void {
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
    const runStore = {
      advance: vi
        .fn<NonNullable<RunAdvanceStore['advance']>>()
        .mockResolvedValue({ kind: 'no_change', revision: 0 }),
      close: vi
        .fn<NonNullable<RunAdvanceStore['close']>>()
        .mockResolvedValue(undefined),
    } satisfies RunAdvanceStore;
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
        consumerFactory: (options): QueueConsumer => {
          consumerOptions = options;
          return consumer;
        },
        dueWakeupScanner: {
          claimDueWakeups: vi.fn().mockResolvedValue(0),
          close: vi.fn().mockResolvedValue(undefined),
        },
        testSuiteScanner: {
          scan: vi.fn().mockResolvedValue(0),
          close: vi.fn(),
        },
        deadlineWakeupScanner: {
          claimDueWakeups: vi.fn().mockResolvedValue(0),
          close: vi.fn().mockResolvedValue(undefined),
        },
        runStore,
        callStore: {
          performActions: vi.fn().mockResolvedValue(undefined),
          close: vi.fn(),
        },
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
            workspaceId: WORKSPACE_ID,
            runId: RUN_ID,
            outboxEventId: OUTBOX_EVENT_ID,
          },
          transport: { attemptsMade: 0, jobId: `outbox-${OUTBOX_EVENT_ID}` },
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();
    vi.mocked(runStore.advance).mockRejectedValueOnce(
      new CoordinatorDeliveryMismatchError(),
    );
    await expect(
      consumerOptions?.handler(
        {
          name: JOB_NAME.advanceWorkflowRun,
          data: {
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
    expect(runStore.close).toHaveBeenCalledOnce();
  });
}
