import type {
  NodeAttemptRunStore,
  PublishedWorkflowReader,
} from '@pertexo/database';
import {
  JOB_NAME,
  QUEUE_NAME,
  type QueueConsumer,
  type QueueConsumerOptions,
} from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/unbound-method -- assertions target injected seam fakes */

import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const NODE_RUN_ID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
const OUTBOX_EVENT_ID = '55555555-5555-4555-8555-555555555555';

describe('node-attempt runtime', () => {
  it('fails before adapter creation when HTTP activation capabilities are absent', async () => {
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
          releaseCohort: 'http_activation',
          redisUrl: 'redis://localhost:6379/0',
          workerId: 'worker-1',
        },
        { consumerFactory },
      ),
    ).rejects.toThrow(
      'HTTP activation requires connection and artifact runtime capabilities',
    );
    expect(consumerFactory).not.toHaveBeenCalled();
  });

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
});
