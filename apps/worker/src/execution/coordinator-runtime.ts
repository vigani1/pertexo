import {
  CoordinatorDeliveryMismatchError,
  createDueNodeWakeupScanner,
  createDeadlineWakeupScanner,
  createRunAdvanceStore,
  type DueNodeWakeupScanner,
  type DeadlineWakeupScanner,
  type RunAdvanceStore,
} from '@pertexo/database/runs';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { advanceRun } from '@pertexo/execution';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
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
import { composeExecutableCatalog } from '@pertexo/workflow-engine';

import {
  createCoordinatorTelemetry,
  type CoordinatorTelemetry,
} from './coordinator-telemetry.js';
import {
  createCoordinatorHandler,
  type CoordinatorHandler,
  type CoordinatorHandlerDependencies,
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
  workspaceInboxProducerEnabled?: boolean;
  /** ADR 056: record schedule and webhook run outcomes for failure streaks. */
  workflowTriggerOutcomesEnabled?: boolean;
  observer?: QueueConsumerObserver;
  redisUrl: string;
}>;

export type CoordinatorRuntimeDependencies = Readonly<{
  /** Replaces `advanceRun` composed from the store and the engine. */
  advance?: CoordinatorHandlerDependencies['advance'];
  clock?: Readonly<{ now(): string }>;
  consumerFactory?: typeof createQueueConsumer;
  dueWakeupScanner?: DueNodeWakeupScanner;
  deadlineWakeupScanner?: DeadlineWakeupScanner;
  notifications?: RunEventNotificationPublisher;
  runStore?: RunAdvanceStore;
  telemetry?: CoordinatorTelemetry;
  logger?: StructuredLogger;
}>;

export type CoordinatorCompositionFactories = Readonly<{
  consumer: typeof createQueueConsumer;
  deadlineScanner: typeof createDeadlineWakeupScanner;
  dueScanner: typeof createDueNodeWakeupScanner;
  notifications(redisUrl: string): RunEventNotificationPublisher;
  runStore: typeof createRunAdvanceStore;
  telemetry: typeof createCoordinatorTelemetry;
  traceRunner: typeof createQueueTraceRunner;
}>;

const productionFactories: CoordinatorCompositionFactories = {
  consumer: createQueueConsumer,
  deadlineScanner: createDeadlineWakeupScanner,
  dueScanner: createDueNodeWakeupScanner,
  notifications: (redisUrl) =>
    new RedisRunEventNotificationPublisher({ redisUrl }),
  runStore: createRunAdvanceStore,
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
  const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
  const telemetry = dependencies.telemetry ?? factories.telemetry();
  const traceRunner = factories.traceRunner();
  let runStore: RunAdvanceStore | undefined;
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
        workspaceInboxProducerEnabled:
          options.workspaceInboxProducerEnabled ?? false,
        workflowTriggerOutcomesEnabled:
          options.workflowTriggerOutcomesEnabled ?? false,
      });
    notifications =
      dependencies.notifications ?? factories.notifications(options.redisUrl);
    dueWakeupScanner =
      dependencies.dueWakeupScanner ??
      factories.dueScanner(options.database, options.databaseRuntime);
    deadlineWakeupScanner =
      dependencies.deadlineWakeupScanner ??
      factories.deadlineScanner(options.database, options.databaseRuntime);
    const clock = dependencies.clock ?? systemClock();
    const advanceDependencies = Object.freeze({
      runs: runStore,
      verification: { catalog },
      maximumAdmissions: options.maximumAdmissions,
      now: () => clock.now(),
    });
    const handler = createCoordinatorHandler({
      advance:
        dependencies.advance ??
        ((input) => advanceRun(advanceDependencies, input)),
      notifications,
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
