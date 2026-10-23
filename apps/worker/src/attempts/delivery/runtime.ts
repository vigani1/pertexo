import type { CallbackKeyConfig } from '@pertexo/integrations/server';
import type { WorkerCodeRunnerConfig } from '../code/client.js';
import {
  createNodeAttemptRunStore,
  type NodeAttemptRunStore,
} from '@pertexo/database/attempts';
import {
  createWorkflowExecutionReader,
  type WorkflowExecutionReader,
} from '@pertexo/database/runs';
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
import type { NodeExecutionCapabilityFactories } from '../execution/capabilities.js';
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

export type NodeAttemptRuntimeDependencies = Readonly<{
  capabilityFactory?: typeof createWorkerNodeRuntimeCapabilities;
  consumerFactory?: typeof createQueueConsumer;
  engine?: NodeAttemptExecutionEngine;
  notifications?: RunEventNotificationPublisher;
  reader?: WorkflowExecutionReader;
  registry?: NodeExecutionRegistry;
  runStore?: NodeAttemptRunStore;
  runtimeCapabilities?: NodeExecutionCapabilityFactories;
  previewTelemetry?: PreviewTelemetry;
  previewHandlerFactory?: typeof createPreviewAttemptHandler;
}>;

interface ProductionNodeAttemptRuntime {
  capabilityRuntime?: WorkerNodeRuntimeCapabilities;
  handler: NodeAttemptHandler;
  runtimeCapabilities?: NodeExecutionCapabilityFactories;
}

async function createProductionNodeAttemptRuntime(
  options: NodeAttemptRuntimeOptions,
  dependencies: NodeAttemptRuntimeDependencies,
  own: OwnNodeAttemptResource,
): Promise<ProductionNodeAttemptRuntime> {
  const expressionEvaluator =
    dependencies.engine === undefined ? new JsonataEvaluator() : undefined;
  own(
    'expression evaluator',
    expressionEvaluator?.shutdown.bind(expressionEvaluator),
  );
  const engineOptions: NodeAttemptExecutionEngineOptions = {
    catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
    ...(expressionEvaluator === undefined ? {} : { expressionEvaluator }),
  };
  const engine =
    dependencies.engine ?? createNodeAttemptExecutionEngine(engineOptions);
  const registry =
    dependencies.registry ??
    createPlatformNodeRegistry({
      httpRequest: {
        httpClient: createNodeSecureHttpClient(options.httpRequest),
      },
      httpRequestTelemetry: createHttpProviderTelemetry(),
      slackSendMessageTelemetry: createSlackProviderTelemetry(),
      emailSendNotificationTelemetry: createEmailProviderTelemetry(),
    });
  const runStore =
    dependencies.runStore ??
    createNodeAttemptRunStore(options.database, options.databaseRuntime);
  own('node-attempt run store', runStore.close.bind(runStore));
  const reader =
    dependencies.reader ??
    createWorkflowExecutionReader(options.database, options.databaseRuntime);
  own('published workflow reader', reader.close.bind(reader));
  const notifications =
    dependencies.notifications ??
    new RedisRunEventNotificationPublisher({ redisUrl: options.redisUrl });
  own('run-event notifications', notifications.close.bind(notifications));

  let capabilityRuntime: WorkerNodeRuntimeCapabilities | undefined;
  let runtimeCapabilities = dependencies.runtimeCapabilities;
  if (runtimeCapabilities === undefined)
    capabilityRuntime = await (
      dependencies.capabilityFactory ?? createWorkerNodeRuntimeCapabilities
    )(
      capabilityRuntimeOptions(options),
      options.databaseRuntime === undefined
        ? {}
        : { databaseRuntime: options.databaseRuntime },
    );
  own(
    'node runtime capabilities',
    capabilityRuntime?.close.bind(capabilityRuntime),
  );
  runtimeCapabilities ??= capabilityRuntime?.factories;
  return {
    ...(capabilityRuntime === undefined ? {} : { capabilityRuntime }),
    handler: createNodeAttemptHandler({
      engine,
      heartbeatIntervalMillis: options.heartbeatIntervalMillis,
      leaseDurationSeconds: options.leaseDurationSeconds,
      notifications,
      reader,
      registry,
      runStore,
      ...(runtimeCapabilities === undefined ? {} : { runtimeCapabilities }),
      workerId: options.workerId,
    }),
    ...(runtimeCapabilities === undefined ? {} : { runtimeCapabilities }),
  };
}

export async function createNodeAttemptRuntime(
  options: NodeAttemptRuntimeOptions,
  dependencies: NodeAttemptRuntimeDependencies = {},
): Promise<NodeAttemptRuntime> {
  // Resources supplied through these close-capable ports transfer to this
  // runtime immediately. Capability factory overrides are borrowed; only a
  // capability runtime created here is owned. The consumer is the sole drain
  // barrier; every other owner is released only after that barrier settles.
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
      dependencies,
      own,
    );
    const { capabilityRuntime, runtimeCapabilities } = production;
    const nodeHandler = production.handler;
    const selectedPreviewCapabilities =
      options.preview?.runtimeCapabilities ?? runtimeCapabilities;
    const previewHandler =
      options.preview === undefined
        ? undefined
        : (dependencies.previewHandlerFactory ?? createPreviewAttemptHandler)({
            heartbeatIntervalMillis:
              options.preview.heartbeatIntervalMillis ??
              options.heartbeatIntervalMillis,
            invoker: options.preview.invoker,
            leaseDurationSeconds:
              options.preview.leaseDurationSeconds ??
              options.leaseDurationSeconds,
            runStore: options.preview.runStore,
            telemetry:
              dependencies.previewTelemetry ??
              createProductionPreviewTelemetry(),
            ...(selectedPreviewCapabilities === undefined
              ? {}
              : { runtimeCapabilities: selectedPreviewCapabilities }),
            workerId: options.workerId,
          });
    const consumer = (dependencies.consumerFactory ?? createQueueConsumer)({
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
        await capabilityRuntime?.checkReadiness();
        assertNodeAttemptRuntimeOpen(lifecycle);
      },
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
