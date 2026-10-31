import type { CallbackKeyConfig } from '@pertexo/integrations/server';
import type { WorkerCodeRunnerConfig } from '../code/client.js';
import { createNodeAttemptRunStore } from '@pertexo/database/attempts';
import { createWorkflowExecutionReader } from '@pertexo/database/runs';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import type { ArtifactStoreConfig } from '@pertexo/artifact-store';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import { createQueueTraceRunner } from '@pertexo/observability';
import {
  createQueueConsumer,
  QUEUE_NAME,
  RedisRunEventNotificationPublisher,
  type QueueConsumer,
  type QueueConsumerObserver,
  type RunEventNotificationPublisher,
} from '@pertexo/queue';
import {
  composeExecutableCatalog,
  type NodeExecutionRegistry,
} from '@pertexo/workflow-engine';
import {
  createNodeSecureHttpClient,
  type ConnectionEnvelopeEncryptionConfig,
  type SecureHttpAddressPolicy,
} from '@pertexo/integrations/server';
import { JsonataEvaluator } from '@pertexo/workflow-model/server';
import {
  createNodeAttemptExecutionEngine,
  type NodeAttemptExecutionEngineOptions,
} from '../execution/engine.js';
import {
  createEmailProviderTelemetry,
  createHttpProviderTelemetry,
  createSlackProviderTelemetry,
} from '../../providers/telemetry.js';
import {
  createProductionPreviewTelemetry,
  type PreviewTelemetry,
} from '../../previews/telemetry.js';
import {
  createNodeAttemptHandler,
  type NodeAttemptExecutionEngine,
  type NodeAttemptHandler,
} from './handler.js';
import {
  createPreviewAttemptHandler,
  type PreviewAttemptRunStore,
  type PreviewNodeInvoker,
  type PreviewRuntimeCapabilityFactories,
} from '../../previews/handler.js';
import {
  createWorkerNodeRuntimeCapabilities,
  type WorkerNodeRuntimeCapabilities,
} from '../execution/runtime-capabilities.js';

import {
  type OwnedNodeAttemptResource,
  assertNodeAttemptRuntimeOpen,
  closeNodeAttemptResources,
  type OwnNodeAttemptResource,
} from './runtime/ownership.js';
import { queueHandler } from './runtime/queue-handler.js';

export interface NodeAttemptRuntime {
  readonly consumer: QueueConsumer;
  checkReadiness(): Promise<void>;
  checkObjectStore(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Preview execution rides the same BullMQ queue as production attempts; the
 * consumer routes by durable job kind so neither capability can steal the
 * other's deliveries.
 */
type PreviewAttemptRuntimeDependency = Readonly<{
  heartbeatIntervalMillis?: number;
  invoker: PreviewNodeInvoker;
  leaseDurationSeconds?: number;
  runStore: PreviewAttemptRunStore & Readonly<{ close?: () => Promise<void> }>;
  runtimeCapabilities?: PreviewRuntimeCapabilityFactories;
}>;

export type NodeAttemptRuntimeOptions = Readonly<{
  callbacks?: CallbackKeyConfig;
  codeRunner?: WorkerCodeRunnerConfig;
  artifactStore?: ArtifactStoreConfig;
  artifactScratchDirectory?: string;
  connectionEncryption?: ConnectionEnvelopeEncryptionConfig;
  database: DatabaseConfig;
  databaseRuntime?: DatabaseRuntime;
  heartbeatIntervalMillis: number;
  /** The HTTP request step's private-network policy. */
  httpRequest?: SecureHttpAddressPolicy;
  leaseDurationSeconds: number;
  observer?: QueueConsumerObserver;
  preview?: PreviewAttemptRuntimeDependency;
  redisUrl: string;
  workerId: string;
}>;

export type NodeAttemptRuntimeFactories = Readonly<{
  capabilities: typeof createWorkerNodeRuntimeCapabilities;
  consumer: typeof createQueueConsumer;
  engine: (
    options: NodeAttemptExecutionEngineOptions,
  ) => NodeAttemptExecutionEngine;
  notifications: (redisUrl: string) => RunEventNotificationPublisher;
  previewHandler: typeof createPreviewAttemptHandler;
  previewTelemetry: () => PreviewTelemetry;
  reader: typeof createWorkflowExecutionReader;
  registry: (httpRequest?: SecureHttpAddressPolicy) => NodeExecutionRegistry;
  runStore: typeof createNodeAttemptRunStore;
}>;

const productionFactories: NodeAttemptRuntimeFactories = {
  capabilities: createWorkerNodeRuntimeCapabilities,
  consumer: createQueueConsumer,
  engine: createNodeAttemptExecutionEngine,
  notifications: (redisUrl) =>
    new RedisRunEventNotificationPublisher({ redisUrl }),
  previewHandler: createPreviewAttemptHandler,
  previewTelemetry: createProductionPreviewTelemetry,
  reader: createWorkflowExecutionReader,
  registry: (httpRequest) =>
    createPlatformNodeRegistry({
      httpRequest: { httpClient: createNodeSecureHttpClient(httpRequest) },
      httpRequestTelemetry: createHttpProviderTelemetry(),
      slackSendMessageTelemetry: createSlackProviderTelemetry(),
      emailSendNotificationTelemetry: createEmailProviderTelemetry(),
    }),
  runStore: createNodeAttemptRunStore,
};

interface ProductionNodeAttemptRuntime {
  capabilityRuntime: WorkerNodeRuntimeCapabilities;
  handler: NodeAttemptHandler;
}

async function createProductionNodeAttemptRuntime(
  options: NodeAttemptRuntimeOptions,
  factories: NodeAttemptRuntimeFactories,
  own: OwnNodeAttemptResource,
): Promise<ProductionNodeAttemptRuntime> {
  const expressionEvaluator = new JsonataEvaluator();
  own(
    'expression evaluator',
    expressionEvaluator.shutdown.bind(expressionEvaluator),
  );
  const engine = factories.engine({
    catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
    expressionEvaluator,
  });
  const registry = factories.registry(options.httpRequest);
  const runStore = factories.runStore(
    options.database,
    options.databaseRuntime,
  );
  own('node-attempt run store', runStore.close.bind(runStore));
  const reader = factories.reader(options.database, options.databaseRuntime);
  own('published workflow reader', reader.close.bind(reader));
  const notifications = factories.notifications(options.redisUrl);
  own('run-event notifications', notifications.close.bind(notifications));

  const capabilityRuntime = await factories.capabilities(
    capabilityRuntimeOptions(options),
    options.databaseRuntime === undefined
      ? {}
      : { databaseRuntime: options.databaseRuntime },
  );
  own(
    'node runtime capabilities',
    capabilityRuntime.close.bind(capabilityRuntime),
  );
  return {
    capabilityRuntime,
    handler: createNodeAttemptHandler({
      engine,
      heartbeatIntervalMillis: options.heartbeatIntervalMillis,
      leaseDurationSeconds: options.leaseDurationSeconds,
      notifications,
      reader,
      registry,
      runStore,
      runtimeCapabilities: capabilityRuntime.factories,
      workerId: options.workerId,
    }),
  };
}

export async function createNodeAttemptRuntime(
  options: NodeAttemptRuntimeOptions,
  overrides: Partial<NodeAttemptRuntimeFactories> = {},
): Promise<NodeAttemptRuntime> {
  const factories = { ...productionFactories, ...overrides };
  // Preview resources transfer to this runtime immediately. The consumer is
  // the sole drain barrier; every other owner is released only after that
  // barrier settles.
  // Same-phase releases remain concurrent so one independent cleanup cannot
  // prevent the others from being attempted.
  const ownedResources: OwnedNodeAttemptResource[] = [];
  const own = (
    name: string,
    close: (() => Promise<unknown>) | undefined,
  ): void => {
    if (close !== undefined)
      ownedResources.push({ close, name, phase: 'release' });
  };
  const previewStore = options.preview?.runStore;
  own(
    'preview run store',
    previewStore?.close === undefined
      ? undefined
      : previewStore.close.bind(previewStore),
  );
  own(
    'preview invoker',
    options.preview?.invoker.close?.bind(options.preview.invoker),
  );

  try {
    const production = await createProductionNodeAttemptRuntime(
      options,
      factories,
      own,
    );
    const { capabilityRuntime } = production;
    const nodeHandler = production.handler;
    const previewHandler =
      options.preview === undefined
        ? undefined
        : factories.previewHandler({
            heartbeatIntervalMillis:
              options.preview.heartbeatIntervalMillis ??
              options.heartbeatIntervalMillis,
            invoker: options.preview.invoker,
            leaseDurationSeconds:
              options.preview.leaseDurationSeconds ??
              options.leaseDurationSeconds,
            runStore: options.preview.runStore,
            telemetry: factories.previewTelemetry(),
            runtimeCapabilities:
              options.preview.runtimeCapabilities ??
              capabilityRuntime.factories,
            workerId: options.workerId,
          });
    const consumer = factories.consumer({
      queueName: QUEUE_NAME.nodeAttempts,
      redisUrl: options.redisUrl,
      handler: queueHandler(nodeHandler, previewHandler),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      traceRunner: createQueueTraceRunner(),
    });
    ownedResources.unshift({
      close: consumer.close.bind(consumer),
      name: 'shared node-attempt consumer',
      phase: 'drain',
    });
    let closePromise: Promise<void> | undefined;
    const lifecycle = { terminal: false };
    return Object.freeze({
      consumer,
      checkReadiness: async (): Promise<void> => {
        assertNodeAttemptRuntimeOpen(lifecycle);
        await capabilityRuntime.checkReadiness();
        assertNodeAttemptRuntimeOpen(lifecycle);
      },
      checkObjectStore: () => capabilityRuntime.checkObjectStore(),
      close: (): Promise<void> => {
        if (closePromise === undefined) {
          lifecycle.terminal = true;
          closePromise = closeNodeAttemptResources(ownedResources);
        }
        return closePromise;
      },
    });
  } catch (error: unknown) {
    await closeNodeAttemptResources(ownedResources, { error });
    throw error;
  }
}

function capabilityRuntimeOptions(
  options: NodeAttemptRuntimeOptions,
): Parameters<typeof createWorkerNodeRuntimeCapabilities>[0] {
  return {
    database: options.database,
    ...(options.callbacks === undefined
      ? {}
      : { callbacks: options.callbacks }),
    ...(options.artifactScratchDirectory === undefined
      ? {}
      : { artifactScratchDirectory: options.artifactScratchDirectory }),
    ...(options.codeRunner === undefined
      ? {}
      : { codeRunner: options.codeRunner }),
    redisUrl: options.redisUrl,
    ...(options.connectionEncryption === undefined
      ? {}
      : { connectionEncryption: options.connectionEncryption }),
    ...(options.artifactStore === undefined
      ? {}
      : { artifactStore: options.artifactStore }),
  };
}
