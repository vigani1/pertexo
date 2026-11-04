import { describe, expect, it, vi } from 'vitest';
import type { FactoryProvider } from '@nestjs/common';
import type {
  PreparedNodeAttempt,
  PreviewAttemptRunStore,
} from '../../src/testing.js';
import { nodeAttemptRuntimeProvider } from '../../src/transport/providers/node-attempts.js';
import {
  database,
  providerConfig,
  providerFactory,
  STORED_CHECKPOINT,
  WORKSPACE_ID,
  RUN_ID,
  NODE_RUN_ID,
  ATTEMPT_ID,
  OUTBOX_EVENT_ID,
  delivery,
  lease,
  capturedHandler,
} from './node-attempt-runtime.fixture.js';
import { testNodeAttemptRuntime } from '../support/runtime-factories.js';
import type {
  NodeAttemptRunStore,
  PublishedWorkflowReader,
} from '@pertexo/core/testing';
import {
  JOB_NAME,
  QUEUE_NAME,
  type QueueConsumer,
  type QueueConsumerOptions,
  type RunEventNotificationPublisher,
} from '@pertexo/queue';
import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';

describe('node-attempt runtime', () => {
  it('closes a preview store created before invoker failure and preserves cleanup failure', async () => {
    const primary = new Error('preview invoker failed');
    const cleanup = new Error('preview store close failed');
    const provider = nodeAttemptRuntimeProvider(
      providerConfig(),
      {},
      {
        createPreviewInvoker: () => {
          throw primary;
        },
        createPreviewRunStore: () =>
          ({ close: vi.fn().mockRejectedValue(cleanup) }) as never,
        createRuntime: vi.fn(),
      },
    ) as FactoryProvider;

    const result = await providerFactory(provider)(undefined).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([primary, cleanup]);
  });

  it.each(['fallback', 'override'] as const)(
    'keeps the explicit preview capability %s contract',
    async (selection) => {
      const fallback = { artifacts: vi.fn() };
      const override = { artifacts: vi.fn() };
      let selectedCapabilities: unknown;
      const runtime = await testNodeAttemptRuntime(
        {
          database,
          heartbeatIntervalMillis: 10,
          leaseDurationSeconds: 30,
          preview: {
            invoker: { invoke: vi.fn() },
            runStore: {
              claim: vi.fn(),
              complete: vi.fn(),
              heartbeat: vi.fn(),
              markDispatched: vi.fn(),
            },
            ...(selection === 'override'
              ? { runtimeCapabilities: override }
              : {}),
          },
          redisUrl: 'redis://localhost:6379/0',
          workerId: 'worker-1',
        },
        {
          engine: { prepare: vi.fn() },
          notifications: {
            close: vi.fn().mockResolvedValue(undefined),
            publish: vi.fn(),
            resync: vi.fn(),
          },
          reader: {
            close: vi.fn().mockResolvedValue(undefined),
            readForExecution: vi.fn(),
          },
          registry: { execute: vi.fn() },
          runStore: {
            recordInput: vi.fn(),
            claimDelivery: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
            complete: vi.fn(),
            heartbeat: vi.fn(),
            loadInputs: vi.fn(),
            readAttemptOutputs: vi.fn().mockResolvedValue([]),
            listNodeOutcomes: vi.fn().mockResolvedValue([]),
            readNodeOutputs: vi.fn().mockResolvedValue([]),
            readLoopDeclaration: vi.fn(),
            markDispatched: vi.fn(),
          },
          consumerFactory: () => ({
            close: vi.fn().mockResolvedValue({
              abortedJobs: 0,
              forced: false,
            }),
            hasStopped: () => false,
            isReady: vi.fn().mockReturnValue(true),
            waitUntilReady: vi.fn().mockResolvedValue(undefined),
          }),
          previewHandlerFactory: (input) => {
            selectedCapabilities = input.runtimeCapabilities;
            return { handle: vi.fn().mockResolvedValue({ kind: 'duplicate' }) };
          },
          runtimeCapabilities: fallback,
        },
      );
      try {
        expect(selectedCapabilities).toBe(
          selection === 'override' ? override : fallback,
        );
      } finally {
        await runtime.close();
      }
    },
  );

  it('cleans every transferred resource when capability construction fails and preserves cleanup errors', async () => {
    const primary = new Error('capability construction failed');
    const cleanup = new Error('reader close failed');
    const closePreview = vi.fn().mockResolvedValue(undefined);
    const closeInvoker = vi.fn().mockResolvedValue(undefined);
    const closeRunStore = vi.fn().mockResolvedValue(undefined);
    const closeReader = vi.fn().mockRejectedValue(cleanup);
    const closeNotifications = vi.fn().mockResolvedValue(undefined);

    const result = await testNodeAttemptRuntime(
      {
        artifactStore: {} as never,
        connectionEncryption: {} as never,
        database,
        heartbeatIntervalMillis: 10,
        leaseDurationSeconds: 30,
        preview: {
          invoker: { close: closeInvoker, invoke: vi.fn() },
          runStore: {
            claim: vi.fn(),
            close: closePreview,
            complete: vi.fn(),
            heartbeat: vi.fn(),
            markDispatched: vi.fn(),
          },
        },
        redisUrl: 'redis://localhost:6379/0',
        workerId: 'worker-1',
      },
      {
        capabilityFactory: vi.fn().mockRejectedValue(primary),
        engine: { prepare: vi.fn() },
        notifications: {
          close: closeNotifications,
          publish: vi.fn(),
          resync: vi.fn(),
        },
        reader: {
          close: closeReader,
          readForExecution: vi.fn(),
        },
        registry: { execute: vi.fn() },
        runStore: {
          recordInput: vi.fn(),
          claimDelivery: vi.fn(),
          close: closeRunStore,
          complete: vi.fn(),
          heartbeat: vi.fn(),
          loadInputs: vi.fn(),
          readAttemptOutputs: vi.fn().mockResolvedValue([]),
          listNodeOutcomes: vi.fn().mockResolvedValue([]),
          readNodeOutputs: vi.fn().mockResolvedValue([]),
          readLoopDeclaration: vi.fn(),
          markDispatched: vi.fn(),
        },
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([primary, cleanup]);
    for (const close of [
      closePreview,
      closeInvoker,
      closeRunStore,
      closeReader,
      closeNotifications,
    ])
      expect(close).toHaveBeenCalledOnce();
  });

  it('drains the shared consumer first, aggregates close failures, and closes only once', async () => {
    const order: string[] = [];
    const consumerFailure = new Error('consumer close failed');
    const storeFailure = new Error('store close failed');
    let rejectConsumer: ((error: Error) => void) | undefined;
    const consumerDrain = new Promise<never>((_resolve, reject) => {
      rejectConsumer = reject;
    });
    const consumerClose = vi.fn(() => {
      order.push('consumer');
      return consumerDrain;
    });
    const storeClose = vi.fn(() => {
      order.push('store');
      throw storeFailure;
    });
    const runtime = await testNodeAttemptRuntime(
      {
        database,
        heartbeatIntervalMillis: 10,
        leaseDurationSeconds: 30,
        redisUrl: 'redis://localhost:6379/0',
        workerId: 'worker-1',
      },
      {
        consumerFactory: () => ({
          close: consumerClose,
          hasStopped: () => false,
          isReady: vi.fn().mockReturnValue(true),
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
        }),
        engine: { prepare: vi.fn() },
        notifications: {
          close: vi.fn().mockResolvedValue(undefined),
          publish: vi.fn(),
          resync: vi.fn(),
        },
        reader: {
          close: vi.fn().mockResolvedValue(undefined),
          readForExecution: vi.fn(),
        },
        registry: { execute: vi.fn() },
        runStore: {
          recordInput: vi.fn(),
          claimDelivery: vi.fn(),
          close: storeClose,
          complete: vi.fn(),
          heartbeat: vi.fn(),
          loadInputs: vi.fn(),
          readAttemptOutputs: vi.fn().mockResolvedValue([]),
          listNodeOutcomes: vi.fn().mockResolvedValue([]),
          readNodeOutputs: vi.fn().mockResolvedValue([]),
          readLoopDeclaration: vi.fn(),
          markDispatched: vi.fn(),
        },
      },
    );

    const first = runtime.close();
    const second = runtime.close();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(order).toEqual(['consumer']);
    expect(storeClose).not.toHaveBeenCalled();
    rejectConsumer?.(consumerFailure);
    const result = await first.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(order[0]).toBe('consumer');
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([
      consumerFailure,
      storeFailure,
    ]);
    expect(consumerClose).toHaveBeenCalledOnce();
    expect(storeClose).toHaveBeenCalledOnce();
    await expect(runtime.checkReadiness()).rejects.toThrow(
      'Node-attempt runtime is closed',
    );
  });

  it('rechecks the terminal fence after an in-flight capability readiness probe', async () => {
    const readiness = Promise.withResolvers<undefined>();
    const capabilityClose = vi.fn().mockResolvedValue(undefined);
    const runtime = await testNodeAttemptRuntime(
      {
        artifactStore: {} as never,
        database,
        heartbeatIntervalMillis: 10,
        leaseDurationSeconds: 30,
        redisUrl: 'redis://localhost:6379/0',
        workerId: 'worker-1',
      },
      {
        capabilityFactory: vi.fn().mockResolvedValue({
          checkReadiness: vi.fn().mockReturnValue(readiness.promise),
          close: capabilityClose,
          factories: {},
        }),
        consumerFactory: () => ({
          close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
          hasStopped: () => false,
          isReady: vi.fn().mockReturnValue(true),
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
        }),
        engine: { prepare: vi.fn() },
        notifications: {
          close: vi.fn().mockResolvedValue(undefined),
          publish: vi.fn(),
          resync: vi.fn(),
        },
        reader: {
          close: vi.fn().mockResolvedValue(undefined),
          readForExecution: vi.fn(),
        },
        registry: { execute: vi.fn() },
        runStore: {
          recordInput: vi.fn(),
          claimDelivery: vi.fn(),
          close: vi.fn().mockResolvedValue(undefined),
          complete: vi.fn(),
          heartbeat: vi.fn(),
          loadInputs: vi.fn(),
          readAttemptOutputs: vi.fn().mockResolvedValue([]),
          listNodeOutcomes: vi.fn().mockResolvedValue([]),
          readNodeOutputs: vi.fn().mockResolvedValue([]),
          readLoopDeclaration: vi.fn(),
          markDispatched: vi.fn(),
        },
      },
    );

    const pendingReadiness = runtime.checkReadiness();
    const closing = runtime.close();
    readiness.resolve(undefined);
    await expect(pendingReadiness).rejects.toThrow(
      'Node-attempt runtime is closed',
    );
    await closing;
    expect(capabilityClose).toHaveBeenCalledOnce();
  });

  it('rejects executor-controlled success without durable dispatch evidence', async () => {
    const runStore = {
      recordInput: vi.fn(),
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
      hasStopped: () => false,
      isReady: vi
        .fn<NonNullable<QueueConsumer['isReady']>>()
        .mockReturnValue(true),
      waitUntilReady: vi
        .fn<NonNullable<QueueConsumer['waitUntilReady']>>()
        .mockResolvedValue(undefined),
    } satisfies QueueConsumer;
    const runStore = {
      recordInput: vi.fn(),
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

  it('closes the preview store when consumer construction fails', async () => {
    const startupError = new Error('consumer construction failed');
    const closePreview = vi.fn().mockResolvedValue(undefined);
    const previewStore = {
      claim: vi.fn<
        NonNullable<
          (PreviewAttemptRunStore & {
            close(): Promise<void>;
          })['claim']
        >
      >(),
      close: closePreview,
      complete: vi.fn<
        NonNullable<
          (PreviewAttemptRunStore & {
            close(): Promise<void>;
          })['complete']
        >
      >(),
      heartbeat: vi.fn<
        NonNullable<
          (PreviewAttemptRunStore & {
            close(): Promise<void>;
          })['heartbeat']
        >
      >(),
      markDispatched: vi.fn<
        NonNullable<
          (PreviewAttemptRunStore & {
            close(): Promise<void>;
          })['markDispatched']
        >
      >(),
    } satisfies PreviewAttemptRunStore & {
      close(): Promise<void>;
    };
    const closeRunStore = vi.fn().mockResolvedValue(undefined);
    const runStore = {
      recordInput: vi.fn(),
      claimDelivery: vi.fn<NonNullable<NodeAttemptRunStore['claimDelivery']>>(),
      close: closeRunStore,
      complete: vi.fn<NonNullable<NodeAttemptRunStore['complete']>>(),
      heartbeat: vi.fn<NonNullable<NodeAttemptRunStore['heartbeat']>>(),
      loadInputs: vi.fn<NonNullable<NodeAttemptRunStore['loadInputs']>>(),
      markDispatched:
        vi.fn<NonNullable<NodeAttemptRunStore['markDispatched']>>(),
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
    } satisfies NodeAttemptRunStore;
    const closeReader = vi.fn().mockResolvedValue(undefined);
    const reader = {
      close: closeReader,
      readForExecution:
        vi.fn<NonNullable<PublishedWorkflowReader['readForExecution']>>(),
    } satisfies PublishedWorkflowReader;
    const closeNotifications = vi.fn().mockResolvedValue(undefined);
    const notifications = {
      close: closeNotifications,
      publish: vi.fn<NonNullable<RunEventNotificationPublisher['publish']>>(),
      resync: vi.fn<NonNullable<RunEventNotificationPublisher['resync']>>(),
    } satisfies RunEventNotificationPublisher;

    await expect(
      testNodeAttemptRuntime(
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
