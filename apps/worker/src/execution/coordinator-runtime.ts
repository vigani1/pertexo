import {
  CoordinatorDeliveryMismatchError,
  createCoordinatorRunStore,
  createPublishedWorkflowReader,
  type CoordinatorRunStore,
  type DatabaseConfig,
  type PublishedWorkflowReader,
} from '@pertexo/database';
import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
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
import { composeExecutableCompatibilityRelease } from '@pertexo/workflow-engine';

import { createCoordinatorAdvanceEngine } from './coordinator-engine.js';
import {
  createCoordinatorHandler,
  type CoordinatorAdvanceEngine,
  type CoordinatorHandler,
  CoordinatorHandlerStateError,
} from './coordinator-handler.js';

export interface CoordinatorRuntime {
  readonly consumer: QueueConsumer;
  close(): Promise<void>;
}

export type CoordinatorRuntimeOptions = Readonly<{
  database: DatabaseConfig;
  maximumAdmissions: number;
  observer?: QueueConsumerObserver;
  redisUrl: string;
}>;

export type CoordinatorRuntimeDependencies = Readonly<{
  clock?: Readonly<{ now(): string }>;
  consumerFactory?: typeof createQueueConsumer;
  engine?: CoordinatorAdvanceEngine;
  reader?: PublishedWorkflowReader;
  runStore?: CoordinatorRunStore;
}>;

function systemClock(): Readonly<{ now(): string }> {
  return Object.freeze({ now: (): string => new Date().toISOString() });
}

function queueHandler(handler: CoordinatorHandler): QueueJobHandler {
  return async (delivery, context): Promise<void> => {
    if (delivery.name !== JOB_NAME.advanceWorkflowRun) {
      throw new InvalidQueueDeliveryError(
        `Coordinator consumer cannot handle ${delivery.name}`,
      );
    }
    try {
      await handler.handle(delivery, context);
    } catch (error: unknown) {
      if (
        error instanceof CoordinatorDeliveryMismatchError ||
        error instanceof CoordinatorHandlerStateError
      ) {
        throw unrecoverableQueueError(
          error instanceof CoordinatorHandlerStateError
            ? `Coordinator delivery is not recoverable: ${error.code}`
            : 'Coordinator delivery failed durable transport verification',
        );
      }
      throw error;
    }
  };
}

export async function createCoordinatorRuntime(
  options: CoordinatorRuntimeOptions,
  dependencies: CoordinatorRuntimeDependencies = {},
): Promise<CoordinatorRuntime> {
  if (
    !Number.isSafeInteger(options.maximumAdmissions) ||
    options.maximumAdmissions < 1 ||
    options.maximumAdmissions > 64
  ) {
    throw new TypeError(
      'Coordinator maximum admissions must be between 1 and 64',
    );
  }
  const release = composeExecutableCompatibilityRelease(CORE_REGISTRY_RELEASE);
  const engine =
    dependencies.engine ??
    createCoordinatorAdvanceEngine({
      admissionRelease: release,
      currentRelease: release,
    });
  const runStore =
    dependencies.runStore ?? createCoordinatorRunStore(options.database);
  const reader =
    dependencies.reader ?? createPublishedWorkflowReader(options.database);
  const handler = createCoordinatorHandler({
    clock: dependencies.clock ?? systemClock(),
    engine,
    maximumAdmissions: options.maximumAdmissions,
    reader,
    runStore,
  });
  let consumer: QueueConsumer;
  try {
    consumer = (dependencies.consumerFactory ?? createQueueConsumer)({
      queueName: QUEUE_NAME.workflowCoordinator,
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
        const consumerResult = await Promise.allSettled([consumer.close()]);
        const adapterResults = await Promise.allSettled([
          reader.close(),
          runStore.close(),
        ]);
        const failure = [...consumerResult, ...adapterResults].find(
          (result) => result.status === 'rejected',
        );
        if (failure?.status === 'rejected') throw failure.reason;
      })();
      return closePromise;
    },
  });
}
