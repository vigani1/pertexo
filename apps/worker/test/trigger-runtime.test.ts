import type {
  PublishedWorkflowReader,
  ScheduleTriggerScanner,
  WorkflowTriggerReconciliationDatabase,
} from '@pertexo/database';
import {
  JOB_NAME,
  QUEUE_NAME,
  type QueueConsumer,
  type QueueConsumerOptions,
} from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';
import type { StructuredLogger } from '@pertexo/observability';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method -- assertions target injected seam fakes */

import { createTriggerRuntime } from '../src/triggers/trigger-runtime.js';

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
  return {
    consumer,
    scanner,
    reader,
    reconciliation,
    logger,
    consumerFactory: (input: QueueConsumerOptions): QueueConsumer => {
      options = input;
      return consumer;
    },
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
  pollIntervalMillis: 20,
  batchSize: 10,
  leaseDurationSeconds: 30,
  redisUrl: 'redis://localhost:6379/0',
  releaseCohort: 'core' as const,
};

describe('trigger runtime', () => {
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
        checkpointFactory: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(selected.consumerOptions()?.traceRunner).toBeDefined();
    await runtime.close();
  });

  it('recovers a transient PostgreSQL scan failure and makes no claims after drain', async () => {
    const selected = dependencies();
    vi.mocked(selected.scanner.scanDue)
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({ claimed: 1, accepted: 0, skipped: 1, deferred: 0 });
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
    { leaseDurationSeconds: 0 },
    { leaseDurationSeconds: 301 },
    { pollIntervalMillis: 9 },
    { pollIntervalMillis: 60_001 },
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
    await runtime.close();
  });
});
