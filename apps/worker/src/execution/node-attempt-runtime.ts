import {
  createNodeAttemptRunStore,
  createPublishedWorkflowReader,
  type DatabaseConfig,
  NodeAttemptDeliveryMismatchError,
  type NodeAttemptRunStore,
  NodeAttemptStateCorruptError,
  type PublishedWorkflowReader,
} from '@pertexo/database';
import { CORE_REGISTRY_RELEASE_SUPPORT } from '@pertexo/nodes-core';
import { createCoreNodeRegistryForRelease } from '@pertexo/nodes-core/server';
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
  createExecutableCompatibilityReleaseSupport,
  type NodeExecutionRegistry,
} from '@pertexo/workflow-engine';
import type { AwsConnectionEnvelopeEncryptionConfig } from '@pertexo/integrations/server';
import {
  createNodeAttemptExecutionEngine,
  type NodeAttemptExecutionEngineOptions,
} from './node-attempt-engine.js';
import {
  createNodeAttemptHandler,
  type NodeAttemptExecutionEngine,
  type NodeAttemptHandler,
  type NodeAttemptRuntimeCapabilityFactories,
  NodeAttemptHandlerStateError,
} from './node-attempt-handler.js';
import {
  createWorkerNodeRuntimeCapabilities,
  type WorkerNodeRuntimeCapabilities,
} from './node-runtime-capabilities.js';

export interface NodeAttemptRuntime {
  readonly consumer: QueueConsumer;
  close(): Promise<void>;
}

export type NodeAttemptRuntimeOptions = Readonly<{
  artifactStore?: ArtifactStoreConfig;
  connectionEncryption?: AwsConnectionEnvelopeEncryptionConfig;
  database: DatabaseConfig;
  heartbeatIntervalMillis: number;
  leaseDurationSeconds: number;
  observer?: QueueConsumerObserver;
  redisUrl: string;
  workerId: string;
}>;

export type NodeAttemptRuntimeDependencies = Readonly<{
  consumerFactory?: typeof createQueueConsumer;
  engine?: NodeAttemptExecutionEngine;
  notifications?: RunEventNotificationPublisher;
  reader?: PublishedWorkflowReader;
  registry?: NodeExecutionRegistry;
  runStore?: NodeAttemptRunStore;
  runtimeCapabilities?: NodeAttemptRuntimeCapabilityFactories;
}>;

function queueHandler(handler: NodeAttemptHandler): QueueJobHandler {
  return async (delivery, context): Promise<void> => {
    if (delivery.name !== JOB_NAME.executeNodeAttempt)
      throw new InvalidQueueDeliveryError(
        `Node-attempt consumer cannot handle ${delivery.name}`,
      );
    try {
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
      throw error;
    }
  };
}

export async function createNodeAttemptRuntime(
  options: NodeAttemptRuntimeOptions,
  dependencies: NodeAttemptRuntimeDependencies = {},
): Promise<NodeAttemptRuntime> {
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
  const releaseSupport = createExecutableCompatibilityReleaseSupport(
    CORE_REGISTRY_RELEASE_SUPPORT.map(composeExecutableCompatibilityRelease),
  );
  const firstDescription = releaseSupport.descriptions[0];
  const latestNodeRelease = CORE_REGISTRY_RELEASE_SUPPORT.at(-1);
  if (firstDescription === undefined || latestNodeRelease === undefined)
    throw new Error('Core compatibility release support is empty');
  const firstRelease = releaseSupport.resolve(
    firstDescription.epoch,
    firstDescription.fingerprint,
  );
  const engineOptions: NodeAttemptExecutionEngineOptions = {
    admissionRelease: firstRelease,
    releaseSupport,
  };
  const engine =
    dependencies.engine ?? createNodeAttemptExecutionEngine(engineOptions);
  const registry =
    dependencies.registry ??
    createCoreNodeRegistryForRelease(latestNodeRelease);
  const runStore =
    dependencies.runStore ?? createNodeAttemptRunStore(options.database);
  const reader =
    dependencies.reader ??
    createPublishedWorkflowReader(
      options.database,
      releaseSupport.descriptions,
    );
  const notifications =
    dependencies.notifications ??
    new RedisRunEventNotificationPublisher({ redisUrl: options.redisUrl });
  let capabilityRuntime: WorkerNodeRuntimeCapabilities | undefined;
  try {
    if (
      dependencies.runtimeCapabilities === undefined &&
      (options.connectionEncryption !== undefined ||
        options.artifactStore !== undefined)
    )
      capabilityRuntime = await createWorkerNodeRuntimeCapabilities({
        database: options.database,
        ...(options.connectionEncryption === undefined
          ? {}
          : { connectionEncryption: options.connectionEncryption }),
        ...(options.artifactStore === undefined
          ? {}
          : { artifactStore: options.artifactStore }),
      });
  } catch (error: unknown) {
    await Promise.allSettled([
      notifications.close(),
      reader.close(),
      runStore.close(),
    ]);
    throw error;
  }
  const runtimeCapabilities =
    dependencies.runtimeCapabilities ?? capabilityRuntime?.factories;
  const handler = createNodeAttemptHandler({
    engine,
    heartbeatIntervalMillis: options.heartbeatIntervalMillis,
    leaseDurationSeconds: options.leaseDurationSeconds,
    notifications,
    reader,
    registry,
    runStore,
    ...(runtimeCapabilities === undefined ? {} : { runtimeCapabilities }),
    workerId: options.workerId,
  });
  let consumer: QueueConsumer;
  try {
    consumer = (dependencies.consumerFactory ?? createQueueConsumer)({
      queueName: QUEUE_NAME.nodeAttempts,
      redisUrl: options.redisUrl,
      handler: queueHandler(handler),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      traceRunner: createQueueTraceRunner(),
    });
  } catch (error: unknown) {
    await Promise.allSettled([
      notifications.close(),
      reader.close(),
      runStore.close(),
      capabilityRuntime?.close(),
    ]);
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    consumer,
    close: (): Promise<void> => {
      closePromise ??= (async (): Promise<void> => {
        const results = await Promise.allSettled([
          consumer.close(),
          notifications.close(),
          reader.close(),
          runStore.close(),
          capabilityRuntime?.close(),
        ]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      })();
      return closePromise;
    },
  });
}
import type { ArtifactStoreConfig } from '@pertexo/artifact-store';
