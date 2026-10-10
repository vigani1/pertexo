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
import { JsonataEvaluator } from '@pertexo/workflow-model/server';

import {
  createCoordinatorTelemetry,
  type CoordinatorTelemetry,
} from './telemetry.js';
import {
  createCoordinatorHandler,
  type CoordinatorHandler,
  type CoordinatorHandlerDependencies,
  CoordinatorHandlerStateError,
} from './handler.js';
import {
  closeOwners,
  createScannerRuntime,
  type ScannerRuntime,
} from '../runtime/scanner.js';

export type CoordinatorRuntime = ScannerRuntime;

export type CoordinatorRuntimeOptions = Readonly<{
  database: DatabaseConfig;
  databaseRuntime?: DatabaseRuntime;
  backgroundTaskShutdownTimeoutMillis?: number;
  dueWakeupBatchSize?: number;
  dueWakeupPollIntervalMillis?: number;
  maximumAdmissions: number;
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
  const dueWakeupBatchSize = options.dueWakeupBatchSize ?? 25;
  const dueWakeupPollIntervalMillis =
    options.dueWakeupPollIntervalMillis ?? 250;
  const backgroundTaskShutdownTimeoutMillis =
    options.backgroundTaskShutdownTimeoutMillis ?? 5_000;
  const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
  const telemetry = dependencies.telemetry ?? factories.telemetry();
  const traceRunner = factories.traceRunner();
  let runStore: RunAdvanceStore | undefined;
  let notifications: RunEventNotificationPublisher | undefined;
  let dueWakeupScanner: DueNodeWakeupScanner | undefined;
  let deadlineWakeupScanner: DeadlineWakeupScanner | undefined;
  let consumer: QueueConsumer | undefined;
  const expressionEvaluator =
    dependencies.advance === undefined ? new JsonataEvaluator() : undefined;
  const expressionOwner =
    expressionEvaluator === undefined
      ? undefined
      : { close: () => expressionEvaluator.shutdown() };
  try {
    runStore =
      dependencies.runStore ??
      factories.runStore(options.database, options.databaseRuntime);
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
      ...(expressionEvaluator === undefined ? {} : { expressionEvaluator }),
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
    const cleanup = await closeOwners(
      [
        dueWakeupScanner,
        deadlineWakeupScanner,
        notifications,
        runStore,
        expressionOwner,
      ],
      backgroundTaskShutdownTimeoutMillis,
    );
    if (cleanup.length > 0)
      throw new AggregateError(
        [error, ...cleanup],
        'Coordinator runtime construction and cleanup failed',
      );
    throw error;
  }
  const dueScanner = dueWakeupScanner;
  const deadlineScanner = deadlineWakeupScanner;
  return createScannerRuntime({
    name: 'Coordinator',
    consumer,
    owners: [
      dueWakeupScanner,
      deadlineWakeupScanner,
      notifications,
      runStore,
      expressionOwner,
    ],
    pollIntervalMillis: dueWakeupPollIntervalMillis,
    shutdownTimeoutMillis: backgroundTaskShutdownTimeoutMillis,
    scan: async (signal) => {
      await dueScanner.claimDueWakeups(dueWakeupBatchSize, signal);
      if (signal.aborted) return;
      await deadlineScanner.claimDueWakeups(dueWakeupBatchSize, signal);
    },
    scanFailed: (error) => {
      dependencies.logger?.error(
        'coordinator.wakeup_scan_failed',
        { safeErrorCode: 'coordinator.wakeup_scan_failed' },
        error,
      );
    },
  });
}
