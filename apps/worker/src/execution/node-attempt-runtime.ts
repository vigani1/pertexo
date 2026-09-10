import {
  createNodeAttemptRunStore,
  createPublishedWorkflowReader,
  type DatabaseConfig,
  type DatabaseRuntime,
  NodeAttemptDeliveryMismatchError,
  type NodeAttemptRunStore,
  NodeAttemptStateCorruptError,
  type PublishedWorkflowReader,
} from '@pertexo/database/execution';
import {
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
  platformServingReleaseRequiresHttpCapabilities,
  platformServingRegistryRelease,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import { createQueueTraceRunner } from '@pertexo/observability';
import {
  createQueueConsumer,
  InvalidQueueDeliveryError,
  JOB_NAME,
  QUEUE_NAME,
  RedisRunEventNotificationPublisher,
  type QueueConsumer,
  type QueueConsumerObserver,
  type QueueJobHandler,
  type RunEventNotificationPublisher,
  unrecoverableQueueError,
} from '@pertexo/queue';
import {
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseHistory,
  createExecutableCompatibilityReleaseSupport,
  type NodeExecutionRegistry,
} from '@pertexo/workflow-engine';
import type { AwsConnectionEnvelopeEncryptionConfig } from '@pertexo/integrations/server';
import { JsonataEvaluator } from '@pertexo/workflow-model/expressions';
import {
  createNodeAttemptExecutionEngine,
  type NodeAttemptExecutionEngineOptions,
} from './node-attempt-engine.js';
import { createProductionHttpProviderTelemetry } from './http-provider-telemetry.js';
import { createProductionSlackProviderTelemetry } from './slack-provider-telemetry.js';
import { createProductionEmailProviderTelemetry } from './email-provider-telemetry.js';
import {
  createProductionPreviewTelemetry,
  type PreviewTelemetry,
} from './preview-telemetry.js';
import {
  createNodeAttemptHandler,
  type NodeAttemptExecutionEngine,
  type NodeAttemptHandler,
  NodeAttemptHandlerStateError,
} from './node-attempt-handler.js';
import type { NodeExecutionCapabilityFactories } from './node-execution-capabilities.js';
import {
  createPreviewAttemptHandler,
  type PreviewAttemptRunStore,
  type PreviewNodeInvoker,
  type PreviewRuntimeCapabilityFactories,
} from './preview-attempt-handler.js';
import {
  createWorkerNodeRuntimeCapabilities,
  type WorkerNodeRuntimeCapabilities,
} from './node-runtime-capabilities.js';
import {
  mapPreviewHandlerError,
  type PreviewAttemptHandler,
} from './preview-attempt-runtime.js';

export interface NodeAttemptRuntime {
  readonly consumer: QueueConsumer;
  checkReadiness?(): Promise<void>;
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
  artifactStore?: DualRegionArtifactStoreConfig;
  connectionEncryption?: AwsConnectionEnvelopeEncryptionConfig;
  database: DatabaseConfig;
  databaseRuntime?: DatabaseRuntime;
  heartbeatIntervalMillis: number;
  leaseDurationSeconds: number;
  observer?: QueueConsumerObserver;
  preview?: PreviewAttemptRuntimeDependency;
  productionEnabled?: boolean;
  releaseCohort?: PlatformReleaseCohort;
  redisUrl: string;
  workerId: string;
}>;

export type NodeAttemptRuntimeDependencies = Readonly<{
  capabilityFactory?: typeof createWorkerNodeRuntimeCapabilities;
  consumerFactory?: typeof createQueueConsumer;
  engine?: NodeAttemptExecutionEngine;
  notifications?: RunEventNotificationPublisher;
  reader?: PublishedWorkflowReader;
  registry?: NodeExecutionRegistry;
  runStore?: NodeAttemptRunStore;
  runtimeCapabilities?: NodeExecutionCapabilityFactories;
  previewTelemetry?: PreviewTelemetry;
  previewHandlerFactory?: typeof createPreviewAttemptHandler;
}>;

type OwnedNodeAttemptResource = Readonly<{
  close: () => Promise<unknown>;
  name: string;
  phase: 'drain' | 'release';
}>;

async function closeNodeAttemptResources(
  resources: readonly OwnedNodeAttemptResource[],
  primary?: Readonly<{ error: unknown }>,
): Promise<void> {
  const drainSettled = await Promise.allSettled(
    resources
      .filter(({ phase }) => phase === 'drain')
      .map(({ close }) => close()),
  );
  const releaseSettled = await Promise.allSettled(
    resources
      .filter(({ phase }) => phase === 'release')
      .map(({ close }) => close()),
  );
  const cleanupFailures: unknown[] = [];
  for (const result of [...drainSettled, ...releaseSettled])
    if (result.status === 'rejected')
      cleanupFailures.push(result.reason as unknown);
  const failures: unknown[] = [
    ...(primary === undefined ? [] : [primary.error]),
    ...cleanupFailures,
  ];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      primary === undefined
        ? 'Node-attempt runtime cleanup failed'
        : 'Node-attempt runtime construction failed and cleanup was incomplete',
    );
}

function queueHandler(
  handler: NodeAttemptHandler | undefined,
  previewHandler: PreviewAttemptHandler | undefined,
): QueueJobHandler {
  return async (delivery, context): Promise<void> => {
    if (
      delivery.name !== JOB_NAME.executeNodeAttempt &&
      delivery.name !== JOB_NAME.executePreviewAttempt
    )
      throw new InvalidQueueDeliveryError(
        `Node-attempt consumer cannot handle ${delivery.name}`,
      );
    try {
      if (
        previewHandler !== undefined &&
        delivery.name === JOB_NAME.executePreviewAttempt
      ) {
        await previewHandler.handle(delivery, context);
        return;
      }
      if (
        delivery.name !== JOB_NAME.executeNodeAttempt ||
        handler === undefined
      )
        throw new InvalidQueueDeliveryError(
          `Node-attempt consumer cannot handle ${delivery.name}`,
        );
      await handler.handle(delivery, context);
    } catch (error: unknown) {
      if (
        error instanceof NodeAttemptDeliveryMismatchError ||
        error instanceof NodeAttemptStateCorruptError ||
        error instanceof NodeAttemptHandlerStateError
      )
        throw unrecoverableQueueError(
          error instanceof NodeAttemptHandlerStateError
            ? `Node-attempt delivery is not recoverable: ${error.code}`
            : 'Node-attempt delivery failed durable state verification',
        );
      throw mapPreviewHandlerError(error);
    }
  };
}

type OwnNodeAttemptResource = (
  name: string,
  close: (() => Promise<unknown>) | undefined,
) => void;

interface ProductionNodeAttemptRuntime {
  capabilityRuntime?: WorkerNodeRuntimeCapabilities;
  handler: NodeAttemptHandler;
  runtimeCapabilities?: NodeExecutionCapabilityFactories;
}

async function createProductionNodeAttemptRuntime(
  options: NodeAttemptRuntimeOptions,
  dependencies: NodeAttemptRuntimeDependencies,
  releaseCohort: PlatformReleaseCohort,
  own: OwnNodeAttemptResource,
): Promise<ProductionNodeAttemptRuntime> {
  if (
    platformServingReleaseRequiresHttpCapabilities(releaseCohort) &&
    !(
      (options.connectionEncryption !== undefined &&
        options.artifactStore !== undefined) ||
      (dependencies.runtimeCapabilities?.connections !== undefined &&
        dependencies.runtimeCapabilities.artifacts !== undefined)
    )
  )
    throw new TypeError(
      'HTTP activation requires connection and artifact runtime capabilities',
    );

  const releaseSupport = createExecutableCompatibilityReleaseHistory(
    platformExecutableRegistryHistory(releaseCohort).map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const firstDescription = releaseSupport.descriptions[0];
  const latestNodeRelease = platformServingRegistryRelease(releaseCohort);
  if (firstDescription === undefined)
    throw new Error('Core compatibility release support is empty');
  const firstRelease = releaseSupport.resolve(
    firstDescription.epoch,
    firstDescription.fingerprint,
  );
  const expressionEvaluator =
    dependencies.engine === undefined ? new JsonataEvaluator() : undefined;
  own(
    'expression evaluator',
    expressionEvaluator?.shutdown.bind(expressionEvaluator),
  );
  const engineOptions: NodeAttemptExecutionEngineOptions = {
    admissionRelease: firstRelease,
    releaseSupport,
    ...(expressionEvaluator === undefined ? {} : { expressionEvaluator }),
  };
  const engine =
    dependencies.engine ?? createNodeAttemptExecutionEngine(engineOptions);
  const registry =
    dependencies.registry ??
    createPlatformNodeRegistryForRelease(latestNodeRelease, {
      httpRequestTelemetry: createProductionHttpProviderTelemetry(),
      slackSendMessageTelemetry: createProductionSlackProviderTelemetry(),
      emailSendNotificationTelemetry: createProductionEmailProviderTelemetry(),
    });
  const runStore =
    dependencies.runStore ??
    createNodeAttemptRunStore(options.database, options.databaseRuntime);
  own('node-attempt run store', runStore.close.bind(runStore));
  const reader =
    dependencies.reader ??
    createPublishedWorkflowReader(
      options.database,
      createExecutableCompatibilityReleaseSupport(
        platformRegistryReleaseSupport(releaseCohort).map(
          composeExecutableCompatibilityRelease,
        ),
      ).descriptions,
      options.databaseRuntime,
    );
  own('published workflow reader', reader.close.bind(reader));
  const notifications =
    dependencies.notifications ??
    new RedisRunEventNotificationPublisher({ redisUrl: options.redisUrl });
  own('run-event notifications', notifications.close.bind(notifications));

  let capabilityRuntime: WorkerNodeRuntimeCapabilities | undefined;
  let runtimeCapabilities = dependencies.runtimeCapabilities;
  if (
    runtimeCapabilities === undefined &&
    (options.connectionEncryption !== undefined ||
      options.artifactStore !== undefined)
  )
    capabilityRuntime = await (
      dependencies.capabilityFactory ?? createWorkerNodeRuntimeCapabilities
    )(
      {
        database: options.database,
        redisUrl: options.redisUrl,
        ...(options.connectionEncryption === undefined
          ? {}
          : { connectionEncryption: options.connectionEncryption }),
        ...(options.artifactStore === undefined
          ? {}
          : { artifactStore: options.artifactStore }),
      },
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
    if (
      !Number.isSafeInteger(options.leaseDurationSeconds) ||
      options.leaseDurationSeconds < 1 ||
      options.leaseDurationSeconds > 300 ||
      !Number.isSafeInteger(options.heartbeatIntervalMillis) ||
      options.heartbeatIntervalMillis < 10 ||
      options.heartbeatIntervalMillis >= options.leaseDurationSeconds * 1_000 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(options.workerId)
    )
      throw new TypeError('Node-attempt runtime options are invalid');
    const releaseCohort = options.releaseCohort ?? 'core';
    const productionEnabled = options.productionEnabled ?? true;
    let capabilityRuntime: WorkerNodeRuntimeCapabilities | undefined;
    let runtimeCapabilities = dependencies.runtimeCapabilities;
    let nodeHandler: NodeAttemptHandler | undefined;
    if (productionEnabled) {
      const production = await createProductionNodeAttemptRuntime(
        options,
        dependencies,
        releaseCohort,
        own,
      );
      capabilityRuntime = production.capabilityRuntime;
      runtimeCapabilities = production.runtimeCapabilities;
      nodeHandler = production.handler;
    }
    const consumer = (dependencies.consumerFactory ?? createQueueConsumer)({
      queueName: QUEUE_NAME.nodeAttempts,
      redisUrl: options.redisUrl,
      handler: queueHandler(
        nodeHandler,
        options.preview === undefined
          ? undefined
          : (dependencies.previewHandlerFactory ?? createPreviewAttemptHandler)(
              {
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
                ...(options.preview.runtimeCapabilities === undefined
                  ? runtimeCapabilities === undefined
                    ? {}
                    : { runtimeCapabilities }
                  : {
                      runtimeCapabilities: options.preview.runtimeCapabilities,
                    }),
                workerId: options.workerId,
              },
            ),
      ),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      traceRunner: createQueueTraceRunner(),
    });
    ownedResources.unshift({
      close: consumer.close.bind(consumer),
      name: 'shared node-attempt consumer',
      phase: 'drain',
    });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      consumer,
      checkReadiness: (): Promise<void> =>
        capabilityRuntime?.checkReadiness() ?? Promise.resolve(),
      close: (): Promise<void> => {
        closePromise ??= closeNodeAttemptResources(ownedResources);
        return closePromise;
      },
    });
  } catch (error: unknown) {
    await closeNodeAttemptResources(ownedResources, { error });
    throw error;
  }
}
import type { DualRegionArtifactStoreConfig } from '@pertexo/artifact-store';
