import {
  createNodeAttemptRunStore,
  createPublishedWorkflowReader,
  type DatabaseConfig,
  NodeAttemptDeliveryMismatchError,
  type NodeAttemptRunStore,
  NodeAttemptStateCorruptError,
  type PublishedWorkflowReader,
} from '@pertexo/database';
import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
import { createCoreNodeRegistry } from '@pertexo/nodes-core/server';
import { createQueueTraceRunner } from '@pertexo/observability';
import {
  createQueueConsumer,
  InvalidQueueDeliveryError,
  JOB_NAME,
  QUEUE_NAME,
  type QueueConsumer,
  type QueueConsumerObserver,
  type QueueJobHandler,
  unrecoverableQueueError,
} from '@pertexo/queue';
import {
  composeExecutableCompatibilityRelease,
  type NodeExecutionRegistry,
} from '@pertexo/workflow-engine';

import {
  createNodeAttemptExecutionEngine,
  type NodeAttemptExecutionEngineOptions,
} from './node-attempt-engine.js';
import {
  createNodeAttemptHandler,
  type NodeAttemptExecutionEngine,
  type NodeAttemptHandler,
  NodeAttemptHandlerStateError,
} from './node-attempt-handler.js';

export interface NodeAttemptRuntime {
  readonly consumer: QueueConsumer;
  close(): Promise<void>;
}

export type NodeAttemptRuntimeOptions = Readonly<{
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
  reader?: PublishedWorkflowReader;
  registry?: NodeExecutionRegistry;
  runStore?: NodeAttemptRunStore;
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
  const release = composeExecutableCompatibilityRelease(CORE_REGISTRY_RELEASE);
  const engineOptions: NodeAttemptExecutionEngineOptions = {
    admissionRelease: release,
    currentRelease: release,
  };
  const engine =
    dependencies.engine ?? createNodeAttemptExecutionEngine(engineOptions);
  const registry = dependencies.registry ?? createCoreNodeRegistry();
  const runStore =
    dependencies.runStore ?? createNodeAttemptRunStore(options.database);
  const reader =
    dependencies.reader ?? createPublishedWorkflowReader(options.database);
  const handler = createNodeAttemptHandler({
    engine,
    heartbeatIntervalMillis: options.heartbeatIntervalMillis,
    leaseDurationSeconds: options.leaseDurationSeconds,
    reader,
    registry,
    runStore,
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
    await Promise.allSettled([reader.close(), runStore.close()]);
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    consumer,
    close: (): Promise<void> => {
      closePromise ??= (async (): Promise<void> => {
        const results = await Promise.allSettled([
          consumer.close(),
          reader.close(),
          runStore.close(),
        ]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      })();
      return closePromise;
    },
  });
}
