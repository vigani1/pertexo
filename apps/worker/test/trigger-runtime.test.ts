import type {
  PublishedWorkflowReader,
  ScheduleTriggerScanner,
  WorkflowTriggerReconciliationDatabase,
} from '@pertexo/database/testing';
import {
  JOB_NAME,
  QUEUE_NAME,
  type QueueConsumer,
  type QueueConsumerOptions,
} from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';
import type { StructuredLogger } from '@pertexo/observability';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method -- assertions target injected seam fakes */

import {
  createTriggerRuntime,
  type TriggerCompositionFactories,
} from '../src/triggers/trigger-runtime.js';

function dependencies() {
  const consumer: QueueConsumer = {
    close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
    isReady: vi.fn().mockReturnValue(true),
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
  };
  const scanner: ScheduleTriggerScanner = {
    close: vi.fn().mockResolvedValue(undefined),
    scanDue: vi.fn().mockResolvedValue({
      claimed: 0,
      accepted: 0,
      skipped: 0,
      deferred: 0,
      maxLagSeconds: 0,
    }),
  };
  const reader: PublishedWorkflowReader = {
    close: vi.fn().mockResolvedValue(undefined),
    readForExecution: vi.fn(),
  };
  const reconciliation: WorkflowTriggerReconciliationDatabase = {
    close: vi.fn().mockResolvedValue(undefined),
    reconcile: vi.fn(),
    recordFailure: vi.fn(),
  };
  let options: QueueConsumerOptions | undefined;
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  } satisfies StructuredLogger;
  const telemetry = {
    reconciliationCompleted: vi.fn(),
    scanCompleted: vi.fn(),
    scanFailed: vi.fn(),
  };
  return {
    consumer,
    scanner,
    reader,
    reconciliation,
    logger,
    telemetry,
    consumerFactory: vi.fn((input: QueueConsumerOptions): QueueConsumer => {
      options = input;
      return consumer;
    }),
    consumerOptions: (): QueueConsumerOptions | undefined => options,
  };
}

const options = {
  database: {
    connectionString: 'postgresql://worker:secret@localhost:5432/pertexo',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 5,
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  },
  leaseOwner: 'schedule:worker-test',
  onTimeWindowSeconds: 300,
  pollIntervalMillis: 20,
  batchSize: 10,
  leaseDurationSeconds: 30,
  redisUrl: 'redis://localhost:6379/0',
  releaseCohort: 'core' as const,
};

describe('trigger runtime', () => {
  it.each([
    ['telemetry', []],
    ['traceRunner', []],
    ['reconciliation', []],
    ['reader', ['reconciliation']],
    ['scanner', ['reconciliation', 'reader']],
    ['consumer', ['reconciliation', 'reader', 'scanner']],
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
      const reader = {
        close: vi.fn(() => {
          closed.push('reader');
          return Promise.resolve();
        }),
        readForExecution: vi.fn(),
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
        consumer: vi.fn(() =>
          acquire('consumer', {
            close: vi.fn(),
            isReady: vi.fn(),
            waitUntilReady: vi.fn(),
          }),
        ),
        reader: vi.fn(() => acquire('reader', reader)),
        reconciliation: vi.fn(() => acquire('reconciliation', reconciliation)),
        scanner: vi.fn(() => acquire('scanner', scanner)),
        telemetry: vi.fn(() => acquire('telemetry', {})),
        traceRunner: vi.fn(() => acquire('traceRunner', {})),
      } as unknown as TriggerCompositionFactories;

      await expect(
        createTriggerRuntime(
          options,
          {
            checkpointFactory: () => ({
              engineVersion: 'test',
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
    const selected = dependencies();
    const firstScan = Promise.withResolvers<{
      claimed: number;
      accepted: number;
      skipped: number;
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
    const runtime = await createTriggerRuntime(
      { ...options, pollIntervalMillis: 10 },
      {
        ...selected,
        checkpointFactory: () => ({ engineVersion: 'test', checkpoint: {} }),
      },
    );
    let readinessSettled = false;
    const readiness = runtime.checkReadiness().finally(() => {
      readinessSettled = true;
    });
    await vi.waitFor(() => {
      expect(selected.scanner.scanDue).toHaveBeenCalledOnce();
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(readinessSettled).toBe(false);
    expect(selected.scanner.scanDue).toHaveBeenCalledOnce();
    expect(maximumActive).toBe(1);

    firstScan.resolve({
      claimed: 0,
      accepted: 0,
      skipped: 0,
      deferred: 0,
      maxLagSeconds: 0,
    });
    await readiness;
    await runtime.close();
    await expect(runtime.checkReadiness()).rejects.toThrow(/closed/u);
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
        deferred: 0,
        maxLagSeconds: 0,
      });
    selected.logger.error.mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    const runtime = await createTriggerRuntime(
      { ...options, pollIntervalMillis: 10 },
      {
        ...selected,
        checkpointFactory: () => ({ engineVersion: 'test', checkpoint: {} }),
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
      'trigger.schedule_scan_failed',
      { safeErrorCode: 'trigger.schedule_scan_failed' },
      failure,
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
    const runtime = await createTriggerRuntime(
      { ...options, backgroundTaskShutdownTimeoutMillis: 5 },
      {
        ...selected,
        checkpointFactory: () => ({ engineVersion: 'test', checkpoint: {} }),
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
    expect(selected.reader.close).not.toHaveBeenCalled();
    expect(selected.reconciliation.close).not.toHaveBeenCalled();

    scan.resolve({
      claimed: 0,
      accepted: 0,
      skipped: 0,
      deferred: 0,
      maxLagSeconds: 0,
    });
    await vi.waitFor(() => {
      expect(selected.scanner.close).toHaveBeenCalledOnce();
      expect(selected.reader.close).toHaveBeenCalledOnce();
      expect(selected.reconciliation.close).toHaveBeenCalledOnce();
    });
  });

  it('owns the trigger lifecycle consumer and polls PostgreSQL without overlap', async () => {
    const selected = dependencies();
    const runtime = await createTriggerRuntime(options, {
      ...selected,
      checkpointFactory: () => ({ engineVersion: 'test', checkpoint: {} }),
    });

    expect(selected.consumerOptions()).toMatchObject({
      queueName: QUEUE_NAME.triggerLifecycle,
      redisUrl: options.redisUrl,
    });
    await vi.waitFor(() => {
      expect(selected.scanner.scanDue).toHaveBeenCalled();
    });
    expect(selected.scanner.scanDue).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseOwner: options.leaseOwner,
        limit: options.batchSize,
        leaseSeconds: options.leaseDurationSeconds,
        onTimeWindowSeconds: options.onTimeWindowSeconds,
        checkpointFactory: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(selected.consumerOptions()?.traceRunner).toBeDefined();
    expect(selected.telemetry.scanCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ maxLagSeconds: 0 }),
      expect.any(Number),
    );
    await runtime.close();
  });

  it('recovers a transient PostgreSQL scan failure and makes no claims after drain', async () => {
    const selected = dependencies();
    selected.telemetry.scanCompleted.mockImplementation(() => {
      throw new Error('scan completion metrics unavailable');
    });
    selected.telemetry.scanFailed.mockImplementation(() => {
      throw new Error('scan failure metrics unavailable');
    });
    vi.mocked(selected.scanner.scanDue)
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({
        claimed: 1,
        accepted: 0,
        skipped: 1,
        deferred: 0,
        maxLagSeconds: 3,
      });
    const runtime = await createTriggerRuntime(options, {
      ...selected,
      checkpointFactory: () => ({ engineVersion: 'test', checkpoint: {} }),
    });

    await vi.waitFor(() =>
      expect(runtime.checkReadiness()).rejects.toThrow(/schedule scanner/i),
    );
    expect(selected.logger.error).toHaveBeenCalledWith(
      'trigger.schedule_scan_failed',
      { safeErrorCode: 'trigger.schedule_scan_failed' },
      expect.any(Error),
    );
    expect(selected.telemetry.scanFailed).toHaveBeenCalledWith(
      expect.any(Number),
    );

    await vi.waitFor(() => {
      expect(
        vi.mocked(selected.scanner.scanDue).mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
    });
    await expect(runtime.checkReadiness()).resolves.toBeUndefined();
    await runtime.close();
    const callsAfterClose = vi.mocked(selected.scanner.scanDue).mock.calls
      .length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(selected.scanner.scanDue).toHaveBeenCalledTimes(callsAfterClose);
    expect(selected.consumer.close).toHaveBeenCalledOnce();
    expect(selected.scanner.close).toHaveBeenCalledOnce();
    expect(selected.reader.close).toHaveBeenCalledOnce();
    expect(selected.reconciliation.close).toHaveBeenCalledOnce();
  });

  it('routes only reconciliation jobs and closes constructed stores after consumer setup fails', async () => {
    const selected = dependencies();
    const startupFailure = new Error('redis schema incompatible');

    await expect(
      createTriggerRuntime(options, {
        ...selected,
        checkpointFactory: () => ({ engineVersion: 'test', checkpoint: {} }),
        consumerFactory: () => {
          throw startupFailure;
        },
      }),
    ).rejects.toBe(startupFailure);
    expect(selected.scanner.close).toHaveBeenCalledOnce();
    expect(selected.reader.close).toHaveBeenCalledOnce();
    expect(selected.reconciliation.close).toHaveBeenCalledOnce();
  });

  it.each([
    { batchSize: 0 },
    { batchSize: 101 },
    { batchSize: 1.5 },
    { leaseDurationSeconds: 0 },
    { leaseDurationSeconds: 301 },
    { leaseDurationSeconds: Number.NaN },
    { pollIntervalMillis: 9 },
    { pollIntervalMillis: 60_001 },
    { pollIntervalMillis: 10.5 },
    { onTimeWindowSeconds: 59 },
    { onTimeWindowSeconds: 3_601 },
    { onTimeWindowSeconds: 300.5 },
    { leaseOwner: '' },
    { leaseOwner: 'x'.repeat(129) },
    { backgroundTaskShutdownTimeoutMillis: 0 },
    { backgroundTaskShutdownTimeoutMillis: 120_001 },
  ])(
    'rejects invalid scanner bounds before constructing resources',
    async (override) => {
      const selected = dependencies();
      await expect(
        createTriggerRuntime(
          { ...options, ...override },
          {
            ...selected,
            checkpointFactory: () => ({
              engineVersion: 'test',
              checkpoint: {},
            }),
          },
        ),
      ).rejects.toThrow(/trigger runtime/i);
      expect(selected.consumerFactory).not.toHaveBeenCalled();
      expect(selected.scanner.scanDue).not.toHaveBeenCalled();
    },
  );

  it('uses the public queue handler for reconciliation deliveries', async () => {
    const selected = dependencies();
    vi.mocked(selected.reader.readForExecution).mockResolvedValue({
      kind: 'not_found',
    });
    const runtime = await createTriggerRuntime(options, {
      ...selected,
      checkpointFactory: () => ({ engineVersion: 'test', checkpoint: {} }),
    });

    await expect(
      selected.consumerOptions()?.handler(
        {
          name: JOB_NAME.reconcileWorkflowTriggers,
          data: {
            schemaVersion: 1,
            workspaceId: '11111111-1111-4111-8111-111111111111',
            workflowId: '22222222-2222-4222-8222-222222222222',
            publishedVersionId: '33333333-3333-4333-8333-333333333333',
            outboxEventId: '44444444-4444-4444-8444-444444444444',
          },
          transport: {
            attemptsMade: 0,
            jobId: 'outbox-44444444-4444-4444-8444-444444444444',
          },
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();
    expect(selected.telemetry.reconciliationCompleted).toHaveBeenCalledWith(
      'succeeded',
    );
    await runtime.close();
  });

  it('rejects jobs from outside the trigger lifecycle contract', async () => {
    const selected = dependencies();
    const runtime = await createTriggerRuntime(options, {
      ...selected,
      checkpointFactory: () => ({ engineVersion: 'test', checkpoint: {} }),
    });

    await expect(
      selected.consumerOptions()?.handler(
        {
          name: JOB_NAME.advanceWorkflowRun,
          data: {
            schemaVersion: 1,
            workspaceId: '11111111-1111-4111-8111-111111111111',
            runId: '22222222-2222-4222-8222-222222222222',
            outboxEventId: '44444444-4444-4444-8444-444444444444',
          },
          transport: {
            attemptsMade: 0,
            jobId: 'outbox-44444444-4444-4444-8444-444444444444',
          },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ name: 'InvalidQueueDeliveryError' });
    await runtime.close();
  });
});
