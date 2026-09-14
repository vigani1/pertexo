import {
  CoordinatorDeliveryMismatchError,
  createDueNodeWakeupScanner,
  createDeadlineWakeupScanner,
  createCoordinatorRunStore,
  createPublishedWorkflowReader,
  type CoordinatorRunStore,
  type DatabaseConfig,
  type DatabaseRuntime,
  type DueNodeWakeupScanner,
  type DeadlineWakeupScanner,
  type PublishedWorkflowReader,
} from '@pertexo/database/execution';
import {
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
import {
  createQueueTraceRunner,
  type StructuredLogger,
} from '@pertexo/observability';
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
import {
  closeCoordinatorDependencies,
  createCoordinatorRuntimeLifecycle,
} from './coordinator-runtime-lifecycle.js';

export interface CoordinatorRuntime {
  readonly consumer: QueueConsumer;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

export type CoordinatorRuntimeOptions = Readonly<{
  database: DatabaseConfig;
  databaseRuntime?: DatabaseRuntime;
  backgroundTaskShutdownTimeoutMillis?: number;
  dueWakeupBatchSize?: number;
  dueWakeupPollIntervalMillis?: number;
  maximumAdmissions: number;
  runTimeoutFailureContextEnabled?: boolean;
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
  logger?: StructuredLogger;
}>;

export type CoordinatorCompositionFactories = Readonly<{
  consumer: typeof createQueueConsumer;
  deadlineScanner: typeof createDeadlineWakeupScanner;
  dueScanner: typeof createDueNodeWakeupScanner;
  notifications(redisUrl: string): RunEventNotificationPublisher;
  reader: typeof createPublishedWorkflowReader;
  runStore: typeof createCoordinatorRunStore;
  telemetry: typeof createCoordinatorTelemetry;
  traceRunner: typeof createQueueTraceRunner;
}>;

const productionFactories: CoordinatorCompositionFactories = {
  consumer: createQueueConsumer,
  deadlineScanner: createDeadlineWakeupScanner,
  dueScanner: createDueNodeWakeupScanner,
  notifications: (redisUrl) =>
    new RedisRunEventNotificationPublisher({ redisUrl }),
  reader: createPublishedWorkflowReader,
  runStore: createCoordinatorRunStore,
  telemetry: createCoordinatorTelemetry,
  traceRunner: createQueueTraceRunner,
};

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
  factories: CoordinatorCompositionFactories = productionFactories,
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
  const backgroundTaskShutdownTimeoutMillis =
    options.backgroundTaskShutdownTimeoutMillis ?? 5_000;
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
  if (
    !Number.isSafeInteger(backgroundTaskShutdownTimeoutMillis) ||
    backgroundTaskShutdownTimeoutMillis < 1 ||
    backgroundTaskShutdownTimeoutMillis > 120_000
  )
    throw new TypeError(
      'Background task shutdown timeout must be between 1 and 120000',
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
  const currentReleaseDescriptions =
    createExecutableCompatibilityReleaseSupport(
      platformRegistryReleaseSupport(options.releaseCohort ?? 'core').map(
        composeExecutableCompatibilityRelease,
      ),
    ).descriptions;
  const telemetry = dependencies.telemetry ?? factories.telemetry();
  const traceRunner = factories.traceRunner();
  let runStore: CoordinatorRunStore | undefined;
  let reader: PublishedWorkflowReader | undefined;
  let notifications: RunEventNotificationPublisher | undefined;
  let dueWakeupScanner: DueNodeWakeupScanner | undefined;
  let deadlineWakeupScanner: DeadlineWakeupScanner | undefined;
  let consumer: QueueConsumer | undefined;
  try {
    runStore =
      dependencies.runStore ??
      factories.runStore(options.database, options.databaseRuntime, {
        runTimeoutFailureContextEnabled:
          options.runTimeoutFailureContextEnabled ?? false,
      });
    reader =
      dependencies.reader ??
      factories.reader(
        options.database,
        currentReleaseDescriptions,
        options.databaseRuntime,
      );
    notifications =
      dependencies.notifications ?? factories.notifications(options.redisUrl);
    dueWakeupScanner =
      dependencies.dueWakeupScanner ??
      factories.dueScanner(options.database, options.databaseRuntime);
    deadlineWakeupScanner =
      dependencies.deadlineWakeupScanner ??
      factories.deadlineScanner(options.database, options.databaseRuntime);
    const handler = createCoordinatorHandler({
      clock: dependencies.clock ?? systemClock(),
      engine,
      maximumAdmissions: options.maximumAdmissions,
      notifications,
      reader,
      runStore,
      telemetry,
    });
    consumer = (dependencies.consumerFactory ?? factories.consumer)({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: options.redisUrl,
      handler: queueHandler(handler),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      traceRunner,
    });
  } catch (error: unknown) {
    const cleanup = await closeCoordinatorDependencies(
      {
        deadlineWakeupScanner,
        dueWakeupScanner,
        notifications,
        reader,
        runStore,
      },
      backgroundTaskShutdownTimeoutMillis,
    );
    if (cleanup.length > 0)
      throw new AggregateError(
        [error, ...cleanup],
        'Coordinator runtime construction and cleanup failed',
      );
    throw error;
  }
  return createCoordinatorRuntimeLifecycle(
    {
      consumer,
      deadlineWakeupScanner,
      dueWakeupScanner,
      notifications,
      reader,
      runStore,
    },
    {
      batchSize: dueWakeupBatchSize,
      ...(dependencies.logger === undefined
        ? {}
        : { logger: dependencies.logger }),
      pollIntervalMillis: dueWakeupPollIntervalMillis,
      shutdownTimeoutMillis: backgroundTaskShutdownTimeoutMillis,
    },
  );
}
