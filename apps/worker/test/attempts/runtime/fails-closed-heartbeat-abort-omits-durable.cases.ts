import type {
  NodeAttemptRunStore,
  PublishedWorkflowReader,
} from '@pertexo/database/testing';
import {
  JOB_NAME,
  QUEUE_NAME,
  type QueueConsumer,
  type QueueConsumerOptions,
  type RunEventNotificationPublisher,
} from '@pertexo/queue';
import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';

import { expect, it, vi } from 'vitest';
import type { PreparedNodeAttempt } from '../../../src/testing.js';

import {
  STORED_CHECKPOINT,
  WORKSPACE_ID,
  RUN_ID,
  NODE_RUN_ID,
  ATTEMPT_ID,
  OUTBOX_EVENT_ID,
  delivery,
  lease,
  capturedHandler,
} from './fixture.js';
import { testNodeAttemptRuntime } from '../../support/runtime-factories.js';

export function registerFailsClosedHeartbeatAbortOmitsDurable(): void {
  it('rejects executor-controlled success without durable dispatch evidence', async () => {
    const runStore = {
      claimDelivery: vi
        .fn()
        .mockResolvedValue({ kind: 'claimed', lease: lease() }),
      close: vi
        .fn<NonNullable<NodeAttemptRunStore['close']>>()
        .mockResolvedValue(undefined),
      complete: vi.fn<NonNullable<NodeAttemptRunStore['complete']>>(),
      heartbeat: vi.fn<NonNullable<NodeAttemptRunStore['heartbeat']>>(),
      loadInputs: vi
        .fn<NonNullable<NodeAttemptRunStore['loadInputs']>>()
        .mockResolvedValue({
          checkpoint: STORED_CHECKPOINT,
          control: { kind: 'none' },
          completedNodeOutputs: [],
          runInput: null,
        }),
      readAttemptOutputs: vi
        .fn<NonNullable<NodeAttemptRunStore['readAttemptOutputs']>>()
        .mockResolvedValue([]),
      listNodeOutcomes: vi
        .fn<NonNullable<NodeAttemptRunStore['listNodeOutcomes']>>()
        .mockResolvedValue([]),
      readNodeOutputs: vi
        .fn<NonNullable<NodeAttemptRunStore['readNodeOutputs']>>()
        .mockResolvedValue([]),
      readLoopDeclaration:
        vi.fn<NonNullable<NodeAttemptRunStore['readLoopDeclaration']>>(),
      markDispatched:
        vi.fn<NonNullable<NodeAttemptRunStore['markDispatched']>>(),
    } satisfies NodeAttemptRunStore;
    const registry = {
      dispatchMode: () => 'executor_controlled',
      execute: vi
        .fn<NonNullable<NodeExecutionRegistry['execute']>>()
        .mockResolvedValue({ kind: 'succeeded', output: null }),
    } satisfies NodeExecutionRegistry;
    const { handler, runtime } = await capturedHandler({
      engine: {
        prepare: vi.fn().mockReturnValue({
          upstreamNodeOutputs: [],
          execute: async ({
            registry: preparedRegistry,
            signal,
          }: Parameters<PreparedNodeAttempt['execute']>[0]) => {
            const result = await preparedRegistry.execute({
              config: {},
              definition: { key: 'core.manual', version: 1 },
              executor: { key: 'core.manual', version: 1 },
              input: null,
              signal,
            });
            return {
              runId: RUN_ID,
              nodeRunId: NODE_RUN_ID,
              attemptId: ATTEMPT_ID,
              invocationKey: lease().invocationKey,
              nodeId: 'manual',
              kind: result.kind,
              output: result.output,
            };
          },
        }),
      },
      registry,
      runStore,
    });

    try {
      await expect(
        handler(delivery(), { signal: new AbortController().signal }),
      ).rejects.toThrow(/dispatch_evidence_missing/u);
      expect(runStore.markDispatched).not.toHaveBeenCalled();
      expect(runStore.complete).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it('composes the IDs-only node queue and closes every owned adapter', async () => {
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
      claimDelivery: vi
        .fn<NonNullable<NodeAttemptRunStore['claimDelivery']>>()
        .mockResolvedValue({ kind: 'duplicate' }),
      close: vi
        .fn<NonNullable<NodeAttemptRunStore['close']>>()
        .mockResolvedValue(undefined),
      complete: vi.fn<NonNullable<NodeAttemptRunStore['complete']>>(),
      heartbeat: vi.fn<NonNullable<NodeAttemptRunStore['heartbeat']>>(),
      loadInputs: vi.fn<NonNullable<NodeAttemptRunStore['loadInputs']>>(),
      readAttemptOutputs: vi
        .fn<NonNullable<NodeAttemptRunStore['readAttemptOutputs']>>()
        .mockResolvedValue([]),
      listNodeOutcomes: vi
        .fn<NonNullable<NodeAttemptRunStore['listNodeOutcomes']>>()
        .mockResolvedValue([]),
      readNodeOutputs: vi
        .fn<NonNullable<NodeAttemptRunStore['readNodeOutputs']>>()
        .mockResolvedValue([]),
      readLoopDeclaration:
        vi.fn<NonNullable<NodeAttemptRunStore['readLoopDeclaration']>>(),
      markDispatched:
        vi.fn<NonNullable<NodeAttemptRunStore['markDispatched']>>(),
    } satisfies NodeAttemptRunStore;
    const reader = {
      close: vi
        .fn<NonNullable<PublishedWorkflowReader['close']>>()
        .mockResolvedValue(undefined),
      readForExecution:
        vi.fn<NonNullable<PublishedWorkflowReader['readForExecution']>>(),
    } satisfies PublishedWorkflowReader;
    const notifications = {
      close: vi
        .fn<NonNullable<RunEventNotificationPublisher['close']>>()
        .mockResolvedValue(undefined),
      publish: vi.fn<NonNullable<RunEventNotificationPublisher['publish']>>(),
      resync: vi.fn<NonNullable<RunEventNotificationPublisher['resync']>>(),
    } satisfies RunEventNotificationPublisher;
    const runtime = await testNodeAttemptRuntime(
      {
        database: {
          connectionString:
            'postgresql://pertexo_app:secret@localhost:5432/pertexo',
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
          max: 5,
          ownerRole: 'pertexo_owner',
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
        notifications,
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
    expect(notifications.close).toHaveBeenCalledOnce();
  });
}
