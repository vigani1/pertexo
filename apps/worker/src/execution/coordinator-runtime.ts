import {
  CoordinatorDeliveryMismatchError,
  createDueNodeWakeupScanner,
  createDeadlineWakeupScanner,
  createCoordinatorRunStore,
  createPublishedWorkflowReader,
  type CoordinatorRunStore,
  type DatabaseConfig,
  type DueNodeWakeupScanner,
  type DeadlineWakeupScanner,
  type PublishedWorkflowReader,
} from '@pertexo/database/execution';
import {
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
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
} from '@pertexo/workflow-engine';

import { createCoordinatorAdvanceEngine } from './coordinator-engine.js';
import {
  createCoordinatorTelemetry,
  type CoordinatorTelemetry,
} from './coordinator-telemetry.js';
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
  dueWakeupBatchSize?: number;
  dueWakeupPollIntervalMillis?: number;
  maximumAdmissions: number;
  releaseCohort?: PlatformReleaseCohort;
  observer?: QueueConsumerObserver;
  redisUrl: string;
}>;

export type CoordinatorRuntimeDependencies = Readonly<{
  clock?: Readonly<{ now(): string }>;
  consumerFactory?: typeof createQueueConsumer;
  engine?: CoordinatorAdvanceEngine;
  dueWakeupScanner?: DueNodeWakeupScanner;
  deadlineWakeupScanner?: DeadlineWakeupScanner;
  notifications?: RunEventNotificationPublisher;
  reader?: PublishedWorkflowReader;
  runStore?: CoordinatorRunStore;
  telemetry?: CoordinatorTelemetry;
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

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
  const dueWakeupBatchSize = options.dueWakeupBatchSize ?? 25;
  const dueWakeupPollIntervalMillis =
    options.dueWakeupPollIntervalMillis ?? 250;
  if (
    !Number.isSafeInteger(dueWakeupBatchSize) ||
    dueWakeupBatchSize < 1 ||
    dueWakeupBatchSize > 100
  )
    throw new TypeError('Due wakeup batch size must be between 1 and 100');
  if (
    !Number.isSafeInteger(dueWakeupPollIntervalMillis) ||
    dueWakeupPollIntervalMillis < 10 ||
    dueWakeupPollIntervalMillis > 60_000
  )
    throw new TypeError(
      'Due wakeup poll interval must be between 10 and 60000',
    );
  const releaseSupport = createExecutableCompatibilityReleaseHistory(
    platformExecutableRegistryHistory(options.releaseCohort ?? 'core').map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const firstRelease = releaseSupport.resolve(
    releaseSupport.descriptions[0]?.epoch ?? 0,
    releaseSupport.descriptions[0]?.fingerprint ?? '',
  );
  const engine =
    dependencies.engine ??
    createCoordinatorAdvanceEngine({
      admissionRelease: firstRelease,
      releaseSupport,
    });
  const runStore =
    dependencies.runStore ?? createCoordinatorRunStore(options.database);
  const reader =
    dependencies.reader ??
    createPublishedWorkflowReader(
      options.database,
      createExecutableCompatibilityReleaseSupport(
        platformRegistryReleaseSupport(options.releaseCohort ?? 'core').map(
          composeExecutableCompatibilityRelease,
        ),
      ).descriptions,
    );
  const notifications =
    dependencies.notifications ??
    new RedisRunEventNotificationPublisher({ redisUrl: options.redisUrl });
  const dueWakeupScanner =
    dependencies.dueWakeupScanner ??
    createDueNodeWakeupScanner(options.database);
  const deadlineWakeupScanner =
    dependencies.deadlineWakeupScanner ??
    createDeadlineWakeupScanner(options.database);
  const handler = createCoordinatorHandler({
    clock: dependencies.clock ?? systemClock(),
    engine,
    maximumAdmissions: options.maximumAdmissions,
    notifications,
    reader,
    runStore,
    telemetry: dependencies.telemetry ?? createCoordinatorTelemetry(),
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
    await Promise.allSettled([
      notifications.close(),
      dueWakeupScanner.close(),
      deadlineWakeupScanner.close(),
      reader.close(),
      runStore.close(),
    ]);
    throw error;
  }
  const scannerAbort = new AbortController();
  const scannerLoop = (async (): Promise<void> => {
    while (!scannerAbort.signal.aborted) {
      try {
        await dueWakeupScanner.claimDueWakeups(dueWakeupBatchSize);
        await deadlineWakeupScanner.claimDueWakeups(dueWakeupBatchSize);
      } catch {
        // A transient database outage must not terminate the coordinator process.
      }
      await delay(dueWakeupPollIntervalMillis, scannerAbort.signal);
    }
  })();
  let closePromise: Promise<void> | undefined;

  return Object.freeze({
    consumer,
    close: (): Promise<void> => {
      closePromise ??= (async (): Promise<void> => {
        scannerAbort.abort();
        const consumerResult = await Promise.allSettled([consumer.close()]);
        const scannerDrainResult = await Promise.allSettled([scannerLoop]);
        const scannerCloseResult = await Promise.allSettled([
          dueWakeupScanner.close(),
          deadlineWakeupScanner.close(),
        ]);
        const adapterResults = await Promise.allSettled([
          notifications.close(),
          reader.close(),
          runStore.close(),
        ]);
        const failure = [
          ...consumerResult,
          ...scannerDrainResult,
          ...scannerCloseResult,
          ...adapterResults,
        ].find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      })();
      return closePromise;
    },
  });
}
