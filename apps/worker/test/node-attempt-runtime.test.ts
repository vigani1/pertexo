import type {
  NodeAttemptRunStore,
  PublishedWorkflowReader,
} from '@pertexo/database';
import {
  JOB_NAME,
  QUEUE_NAME,
  type QueueConsumer,
  type QueueConsumerOptions,
  type RunEventNotificationPublisher,
} from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/unbound-method -- assertions target injected seam fakes */

import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';
import type { PreviewAttemptRunStore } from '../src/execution/preview-attempt-handler.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const NODE_RUN_ID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
const OUTBOX_EVENT_ID = '55555555-5555-4555-8555-555555555555';

describe('node-attempt runtime', () => {
  it.each([
    'http_activation',
    'condition_activation',
    'switch_activation',
    'merge_activation',
    'for_each_staging',
    'for_each_activation',
  ] as const)(
    'fails before adapter creation when %s HTTP capabilities are absent',
    async (releaseCohort) => {
      const consumerFactory = vi.fn();

      await expect(
        createNodeAttemptRuntime(
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
            heartbeatIntervalMillis: 10_000,
            leaseDurationSeconds: 30,
            releaseCohort,
            redisUrl: 'redis://localhost:6379/0',
            workerId: 'worker-1',
          },
          { consumerFactory },
        ),
      ).rejects.toThrow(
        'HTTP activation requires connection and artifact runtime capabilities',
      );
      expect(consumerFactory).not.toHaveBeenCalled();
    },
  );

  it('composes the IDs-only node queue and closes every owned adapter', async () => {
    let consumerOptions: QueueConsumerOptions | undefined;
    const consumer: QueueConsumer = {
      close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi.fn().mockReturnValue(true),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
    };
    const runStore: NodeAttemptRunStore = {
      claimDelivery: vi.fn().mockResolvedValue({ kind: 'duplicate' }),
      close: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn(),
      heartbeat: vi.fn(),
      loadInputs: vi.fn(),
      markDispatched: vi.fn(),
    };
    const reader: PublishedWorkflowReader = {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn(),
    };
    const runtime = await createNodeAttemptRuntime(
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
        heartbeatIntervalMillis: 10_000,
        leaseDurationSeconds: 30,
        redisUrl: 'redis://localhost:6379/0',
        workerId: 'worker-1',
      },
      {
        consumerFactory: (options): QueueConsumer => {
          consumerOptions = options;
          return consumer;
        },
        engine: { prepare: vi.fn() },
        reader,
        registry: { execute: vi.fn() },
        runStore,
      },
    );

    expect(consumerOptions).toMatchObject({
      queueName: QUEUE_NAME.nodeAttempts,
      redisUrl: 'redis://localhost:6379/0',
    });
    expect(consumerOptions?.traceRunner).toBeDefined();
    await expect(
      consumerOptions?.handler(
        {
          name: JOB_NAME.executeNodeAttempt,
          data: {
            schemaVersion: 1,
            workspaceId: WORKSPACE_ID,
            runId: RUN_ID,
            nodeRunId: NODE_RUN_ID,
            attemptId: ATTEMPT_ID,
            outboxEventId: OUTBOX_EVENT_ID,
          },
          transport: { attemptsMade: 0, jobId: `outbox-${OUTBOX_EVENT_ID}` },
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();

    await runtime.close();
    await runtime.close();
    expect(consumer.close).toHaveBeenCalledOnce();
    expect(reader.close).toHaveBeenCalledOnce();
    expect(runStore.close).toHaveBeenCalledOnce();
  });

  it('closes the preview store when consumer construction fails', async () => {
    const startupError = new Error('consumer construction failed');
    const closePreview = vi.fn().mockResolvedValue(undefined);
    const previewStore: PreviewAttemptRunStore & {
      close(): Promise<void>;
    } = {
      claim: vi.fn(),
      close: closePreview,
      complete: vi.fn(),
      heartbeat: vi.fn(),
      markDispatched: vi.fn(),
    };
    const closeRunStore = vi.fn().mockResolvedValue(undefined);
    const runStore: NodeAttemptRunStore = {
      claimDelivery: vi.fn(),
      close: closeRunStore,
      complete: vi.fn(),
      heartbeat: vi.fn(),
      loadInputs: vi.fn(),
      markDispatched: vi.fn(),
    };
    const closeReader = vi.fn().mockResolvedValue(undefined);
    const reader: PublishedWorkflowReader = {
      close: closeReader,
      readForExecution: vi.fn(),
    };
    const closeNotifications = vi.fn().mockResolvedValue(undefined);
    const notifications: RunEventNotificationPublisher = {
      close: closeNotifications,
      publish: vi.fn(),
      resync: vi.fn(),
    };

    await expect(
      createNodeAttemptRuntime(
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
          heartbeatIntervalMillis: 10_000,
          leaseDurationSeconds: 30,
          preview: {
            invoker: { invoke: vi.fn() },
            runStore: previewStore,
          },
          redisUrl: 'redis://localhost:6379/0',
          workerId: 'worker-1',
        },
        {
          consumerFactory: () => {
            throw startupError;
          },
          engine: { prepare: vi.fn() },
          notifications,
          reader,
          registry: { execute: vi.fn() },
          runStore,
        },
      ),
    ).rejects.toBe(startupError);

    expect(closePreview).toHaveBeenCalledOnce();
    expect(closeRunStore).toHaveBeenCalledOnce();
    expect(closeReader).toHaveBeenCalledOnce();
    expect(closeNotifications).toHaveBeenCalledOnce();
  });
});
