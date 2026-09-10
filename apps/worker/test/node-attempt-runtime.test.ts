import type {
  NodeAttemptLease,
  NodeAttemptRunStore,
  PublishedWorkflowReader,
  PublishedWorkflowV2Projection,
} from '@pertexo/database/testing';
import {
  JOB_NAME,
  QUEUE_NAME,
  type QueueDelivery,
  type QueueConsumer,
  type QueueConsumerOptions,
  type QueueJobHandler,
  type RunEventNotificationPublisher,
} from '@pertexo/queue';
import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';
import type { FactoryProvider } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/unbound-method -- assertions target injected seam fakes */

import {
  createNodeAttemptRuntime,
  type NodeAttemptExecutionEngine,
  type NodeAttemptRuntime,
  type NodeAttemptRuntimeOptions,
  type PreparedNodeAttempt,
  type PreviewAttemptRunStore,
} from '../src/testing.js';
import {
  nodeAttemptActivation,
  nodeAttemptRuntimeProvider,
} from '../src/transport/node-attempt-runtime-provider.js';
import type { WorkerConfig } from '../src/config/worker-config.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const NODE_RUN_ID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
const OUTBOX_EVENT_ID = '55555555-5555-4555-8555-555555555555';
const VERSION_ID = '66666666-6666-4666-8666-666666666666';
const WORKFLOW_ID = '77777777-7777-4777-8777-777777777777';

const database = {
  connectionString: 'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  max: 5,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

function activationConfig(enabledJobNames: readonly string[]): WorkerConfig {
  return {
    database,
    nodeAttempt: {
      heartbeatIntervalMillis: 10,
      leaseDurationSeconds: 30,
      workerId: 'worker-1',
    },
    nodeCompatibilityCohort: 'core',
    outboxDispatcher: { enabledJobNames },
    redisUrl: 'redis://localhost:6379/0',
  } as unknown as WorkerConfig;
}

function providerFactory(provider: FactoryProvider) {
  return provider.useFactory as (
    observer: QueueConsumerOptions['observer'],
  ) => Promise<NodeAttemptRuntime | undefined>;
}

function delivery(): Extract<QueueDelivery, { name: 'execute-node-attempt' }> {
  return {
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
  };
}

function projection(): PublishedWorkflowV2Projection {
  return {
    id: VERSION_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: WORKFLOW_ID,
    versionNumber: 1,
    schemaVersion: 1,
    checksum:
      'wf:v2:sha256:1111111111111111111111111111111111111111111111111111111111111111',
    executableSchemaVersion: 2,
    executableJson: { schemaVersion: 2 },
    compatibilityReleaseEpoch: 1,
  };
}

function lease(): NodeAttemptLease {
  return {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    workflowVersionId: VERSION_ID,
    nodeRunId: NODE_RUN_ID,
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    admissionKind: 'execute',
    invocationKey: `${VERSION_ID}|manual|b:|i:`,
    nodeId: 'manual',
    sideEffectClass: 'safe',
    workerId: 'worker-1',
    fenceToken: 1,
    leaseExpiresAt: new Date('2026-08-21T00:01:00.000Z'),
    delivery: {
      outboxEventId: OUTBOX_EVENT_ID,
      payloadChecksum: 'a'.repeat(64),
    },
  };
}

async function capturedHandler(
  input: Readonly<{
    runStore: NodeAttemptRunStore;
    engine: NodeAttemptExecutionEngine;
    registry: NodeExecutionRegistry;
  }>,
): Promise<
  Readonly<{ handler: QueueJobHandler; runtime: NodeAttemptRuntime }>
> {
  let handler: QueueJobHandler | undefined;
  const runtime = await createNodeAttemptRuntime(
    {
      database,
      heartbeatIntervalMillis: 10,
      leaseDurationSeconds: 30,
      redisUrl: 'redis://localhost:6379/0',
      workerId: 'worker-1',
    },
    {
      consumerFactory: (options) => {
        handler = options.handler;
        return {
          close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
          isReady: vi.fn().mockReturnValue(true),
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
        };
      },
      engine: input.engine,
      notifications: {
        close: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn(),
        resync: vi.fn(),
      },
      reader: {
        close: vi.fn().mockResolvedValue(undefined),
        readForExecution: vi.fn().mockResolvedValue({
          kind: 'v2_projection',
          workflowVersion: projection(),
        }),
      },
      registry: input.registry,
      runStore: input.runStore,
    },
  );
  if (handler === undefined)
    throw new Error('Consumer handler was not captured');
  return { handler, runtime };
}

describe('node-attempt runtime', () => {
  it.each([
    { jobs: [], expected: { preview: false, production: false } },
    {
      jobs: [JOB_NAME.executeNodeAttempt],
      expected: { preview: false, production: true },
    },
    {
      jobs: [JOB_NAME.executePreviewAttempt],
      expected: { preview: true, production: false },
    },
    {
      jobs: [JOB_NAME.executeNodeAttempt, JOB_NAME.executePreviewAttempt],
      expected: { preview: true, production: true },
    },
  ])(
    'describes the four node-attempt activation modes',
    ({ jobs, expected }) => {
      expect(nodeAttemptActivation(jobs)).toEqual(expected);
    },
  );

  it.each([
    {
      jobs: [JOB_NAME.executeNodeAttempt],
      productionEnabled: true,
      preview: false,
    },
    {
      jobs: [JOB_NAME.executePreviewAttempt],
      productionEnabled: false,
      preview: true,
    },
    {
      jobs: [JOB_NAME.executeNodeAttempt, JOB_NAME.executePreviewAttempt],
      productionEnabled: true,
      preview: true,
    },
  ])(
    'composes enabled modes through one shared runtime and transfers preview ownership',
    async ({ jobs, productionEnabled, preview }) => {
      const closePreview = vi.fn().mockResolvedValue(undefined);
      const createRuntime = vi.fn().mockResolvedValue({
        consumer: {},
        close: vi.fn(),
      });
      const provider = nodeAttemptRuntimeProvider(
        activationConfig(jobs),
        {},
        {
          createPreviewInvoker: vi.fn().mockReturnValue({
            close: vi.fn(),
            invoke: vi.fn(),
          }),
          createPreviewRunStore: vi.fn().mockReturnValue({
            claim: vi.fn(),
            close: closePreview,
            complete: vi.fn(),
            heartbeat: vi.fn(),
            markDispatched: vi.fn(),
          }),
          createRuntime,
        },
      ) as FactoryProvider;

      await expect(providerFactory(provider)(undefined)).resolves.toBeDefined();
      expect(createRuntime).toHaveBeenCalledOnce();
      const [runtimeOptions] = createRuntime.mock.lastCall as unknown as [
        NodeAttemptRuntimeOptions,
      ];
      expect(runtimeOptions.productionEnabled).toBe(productionEnabled);
      expect(runtimeOptions.preview !== undefined).toBe(preview);
      expect(closePreview).not.toHaveBeenCalled();
    },
  );

  it('returns no runtime for disabled mode or an external dispatch registry', async () => {
    const createRuntime = vi.fn();
    const factories = {
      createPreviewInvoker: vi.fn(),
      createPreviewRunStore: vi.fn(),
      createRuntime,
    } as never;
    const disabled = nodeAttemptRuntimeProvider(
      activationConfig([]),
      {},
      factories,
    ) as FactoryProvider;
    await expect(providerFactory(disabled)(undefined)).resolves.toBeUndefined();
    const external = nodeAttemptRuntimeProvider(
      activationConfig([JOB_NAME.executeNodeAttempt]),
      { dispatchConsumerCapabilities: {} as never },
      factories,
    ) as FactoryProvider;
    await expect(providerFactory(external)(undefined)).resolves.toBeUndefined();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('closes a preview store created before invoker failure and preserves cleanup failure', async () => {
    const primary = new Error('preview invoker failed');
    const cleanup = new Error('preview store close failed');
    const provider = nodeAttemptRuntimeProvider(
      activationConfig([JOB_NAME.executePreviewAttempt]),
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

  it('preview-only HTTP-cohort activation acquires no production dispatch resources', async () => {
    const consumer: QueueConsumer = {
      close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi.fn().mockReturnValue(true),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
    };
    const previewClose = vi.fn().mockResolvedValue(undefined);
    const invokerClose = vi.fn().mockResolvedValue(undefined);
    const productionClose = vi.fn().mockResolvedValue(undefined);
    const runtime = await createNodeAttemptRuntime(
      {
        database,
        heartbeatIntervalMillis: 10,
        leaseDurationSeconds: 30,
        preview: {
          invoker: { close: invokerClose, invoke: vi.fn() },
          runStore: {
            claim: vi.fn(),
            close: previewClose,
            complete: vi.fn(),
            heartbeat: vi.fn(),
            markDispatched: vi.fn(),
          },
        },
        productionEnabled: false,
        releaseCohort: 'http_activation',
        redisUrl: 'redis://localhost:6379/0',
        workerId: 'worker-1',
      },
      {
        consumerFactory: () => consumer,
        engine: { prepare: vi.fn() },
        notifications: {
          close: productionClose,
          publish: vi.fn(),
          resync: vi.fn(),
        },
        reader: {
          close: productionClose,
          readForExecution: vi.fn(),
        },
        registry: { execute: vi.fn() },
        runStore: {
          claimDelivery: vi.fn(),
          close: productionClose,
          complete: vi.fn(),
          heartbeat: vi.fn(),
          loadInputs: vi.fn(),
          markDispatched: vi.fn(),
        },
      },
    );

    await runtime.close();
    expect(consumer.close).toHaveBeenCalledOnce();
    expect(previewClose).toHaveBeenCalledOnce();
    expect(invokerClose).toHaveBeenCalledOnce();
    expect(productionClose).not.toHaveBeenCalled();
  });

  it.each(['fallback', 'override'] as const)(
    'keeps the explicit preview capability %s contract',
    async (selection) => {
      const fallback = { artifacts: vi.fn() };
      const override = { artifacts: vi.fn() };
      let selectedCapabilities: unknown;
      const runtime = await createNodeAttemptRuntime(
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
          productionEnabled: false,
          redisUrl: 'redis://localhost:6379/0',
          workerId: 'worker-1',
        },
        {
          consumerFactory: () => ({
            close: vi.fn().mockResolvedValue({
              abortedJobs: 0,
              forced: false,
            }),
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

    const result = await createNodeAttemptRuntime(
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
          claimDelivery: vi.fn(),
          close: closeRunStore,
          complete: vi.fn(),
          heartbeat: vi.fn(),
          loadInputs: vi.fn(),
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
      return Promise.reject(storeFailure);
    });
    const runtime = await createNodeAttemptRuntime(
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
          claimDelivery: vi.fn(),
          close: storeClose,
          complete: vi.fn(),
          heartbeat: vi.fn(),
          loadInputs: vi.fn(),
          markDispatched: vi.fn(),
        },
      },
    );

    const first = runtime.close();
    const second = runtime.close();
    expect(second).toBe(first);
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
  });

  it('fails closed when a heartbeat abort omits its durable reason', async () => {
    vi.useFakeTimers();
    const runStore: NodeAttemptRunStore = {
      claimDelivery: vi
        .fn()
        .mockResolvedValue({ kind: 'claimed', lease: lease() }),
      close: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn(),
      heartbeat: vi.fn().mockResolvedValue({ abortRequested: true }),
      loadInputs: vi.fn().mockResolvedValue({
        abortRequested: false,
        completedNodeOutputs: {},
        runInput: null,
      }),
      markDispatched: vi.fn(),
    };
    const execute = vi.fn(
      ({ signal }: { readonly signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    const { handler, runtime } = await capturedHandler({
      engine: {
        prepare: vi.fn().mockReturnValue({ upstreamNodeOutputs: [], execute }),
      },
      registry: { execute: vi.fn() },
      runStore,
    });

    try {
      const handled = handler(delivery(), {
        signal: new AbortController().signal,
      });
      const rejected = expect(handled).rejects.toThrow(
        /control_reason_missing/u,
      );
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      expect(runStore.heartbeat).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
      vi.useRealTimers();
    }
  });

  it('rejects executor-controlled success without durable dispatch evidence', async () => {
    const runStore: NodeAttemptRunStore = {
      claimDelivery: vi
        .fn()
        .mockResolvedValue({ kind: 'claimed', lease: lease() }),
      close: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn(),
      heartbeat: vi.fn(),
      loadInputs: vi.fn().mockResolvedValue({
        abortRequested: false,
        completedNodeOutputs: {},
        runInput: null,
      }),
      markDispatched: vi.fn(),
    };
    const registry: NodeExecutionRegistry = {
      dispatchMode: () => 'executor_controlled',
      execute: vi.fn().mockResolvedValue({ kind: 'succeeded', output: null }),
    };
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
