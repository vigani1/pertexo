import {
  createWorkflowTestSuiteScanner,
  type WorkflowTestSuiteScanner,
} from '@pertexo/database/previews';
import {
  CoordinatorDeliveryMismatchError,
  createDueNodeWakeupScanner,
  createDeadlineWakeupScanner,
  createRunAdvanceStore,
  createWorkflowCallStore,
  type DueNodeWakeupScanner,
  type DeadlineWakeupScanner,
  type RunAdvanceStore,
  type WorkflowCallStore,
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

import { createCoordinatorTelemetry } from './telemetry.js';
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
  maintenanceDatabase: DatabaseConfig;
  maintenanceDatabaseRuntime?: DatabaseRuntime;
  databaseRuntime?: DatabaseRuntime;
  backgroundTaskShutdownTimeoutMillis?: number;
  dueWakeupBatchSize?: number;
  dueWakeupPollIntervalMillis?: number;
  maximumAdmissions: number;
  observer?: QueueConsumerObserver;
  redisUrl: string;
  logger?: StructuredLogger;
}>;

export type CoordinatorCompositionFactories = Readonly<{
  advance: (
    dependencies: Parameters<typeof advanceRun>[0],
  ) => CoordinatorHandlerDependencies['advance'];
  consumer: typeof createQueueConsumer;
  deadlineScanner: typeof createDeadlineWakeupScanner;
  dueScanner: typeof createDueNodeWakeupScanner;
  testSuiteScanner: typeof createWorkflowTestSuiteScanner;
  notifications(redisUrl: string): RunEventNotificationPublisher;
  runStore: typeof createRunAdvanceStore;
  callStore: typeof createWorkflowCallStore;
  telemetry: typeof createCoordinatorTelemetry;
  traceRunner: typeof createQueueTraceRunner;
}>;

const productionFactories: CoordinatorCompositionFactories = {
  advance: (dependencies) => (input) => advanceRun(dependencies, input),
  consumer: createQueueConsumer,
  deadlineScanner: createDeadlineWakeupScanner,
  dueScanner: createDueNodeWakeupScanner,
  testSuiteScanner: createWorkflowTestSuiteScanner,
  notifications: (redisUrl) =>
    new RedisRunEventNotificationPublisher({ redisUrl }),
  runStore: createRunAdvanceStore,
  callStore: createWorkflowCallStore,
  telemetry: createCoordinatorTelemetry,
  traceRunner: createQueueTraceRunner,
};

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
  overrides: Partial<CoordinatorCompositionFactories> = {},
): Promise<CoordinatorRuntime> {
  const factories = { ...productionFactories, ...overrides };
  const {
    dueWakeupBatchSize,
    dueWakeupPollIntervalMillis,
    backgroundTaskShutdownTimeoutMillis,
  } = coordinatorRuntimeSettings(options);
  const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
  const telemetry = factories.telemetry();
  const traceRunner = factories.traceRunner();
  let runStore: RunAdvanceStore | undefined;
  let callStore: WorkflowCallStore | undefined;
  let notifications: RunEventNotificationPublisher | undefined;
  let dueWakeupScanner: DueNodeWakeupScanner | undefined;
  let deadlineWakeupScanner: DeadlineWakeupScanner | undefined;
  let testSuiteScanner: WorkflowTestSuiteScanner | undefined;
  let consumer: QueueConsumer | undefined;
  const expressionEvaluator = new JsonataEvaluator();
  const expressionOwner = { close: () => expressionEvaluator.shutdown() };
  try {
    runStore = factories.runStore(options.database, options.databaseRuntime);
    callStore = factories.callStore(
      options.maintenanceDatabase,
      options.maintenanceDatabaseRuntime,
    );
    notifications = factories.notifications(options.redisUrl);
    dueWakeupScanner = factories.dueScanner(
      options.database,
      options.databaseRuntime,
    );
    deadlineWakeupScanner = factories.deadlineScanner(
      options.database,
      options.databaseRuntime,
    );
    testSuiteScanner = await factories.testSuiteScanner(
      options.database,
      options.maintenanceDatabase,
      {
        ...(options.databaseRuntime === undefined
          ? {}
          : { runtime: options.databaseRuntime }),
        ...(options.maintenanceDatabaseRuntime === undefined
          ? {}
          : { maintenanceRuntime: options.maintenanceDatabaseRuntime }),
      },
    );
    const handler = createCoordinatorHandler({
      advance: factories.advance(
        Object.freeze({
          runs: runStore,
          calls: callStore,
          verification: { catalog },
          maximumAdmissions: options.maximumAdmissions,
          now: () => new Date().toISOString(),
          expressionEvaluator,
        }),
      ),
      notifications,
      telemetry,
    });
    consumer = factories.consumer({
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
        testSuiteScanner,
        notifications,
        runStore,
        callStore,
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
  const suiteScanner = testSuiteScanner;
  return createScannerRuntime({
    name: 'Coordinator',
    consumer,
    owners: [
      dueWakeupScanner,
      deadlineWakeupScanner,
      testSuiteScanner,
      notifications,
      runStore,
      callStore,
      expressionOwner,
    ],
    pollIntervalMillis: dueWakeupPollIntervalMillis,
    shutdownTimeoutMillis: backgroundTaskShutdownTimeoutMillis,
    scan: async (signal) => {
      await dueScanner.claimDueWakeups(dueWakeupBatchSize, signal);
      if (signal.aborted) return;
      await deadlineScanner.claimDueWakeups(dueWakeupBatchSize, signal);
      signal.throwIfAborted();
      await suiteScanner.scan(Math.min(25, dueWakeupBatchSize), signal);
    },
    scanFailed: (error) => {
      options.logger?.error(
        'coordinator.wakeup_scan_failed',
        { safeErrorCode: 'coordinator.wakeup_scan_failed' },
        error,
      );
    },
  });
}

function coordinatorRuntimeSettings(options: CoordinatorRuntimeOptions) {
  const dueWakeupBatchSize = options.dueWakeupBatchSize ?? 25;
  const dueWakeupPollIntervalMillis =
    options.dueWakeupPollIntervalMillis ?? 250;
  const backgroundTaskShutdownTimeoutMillis =
    options.backgroundTaskShutdownTimeoutMillis ?? 5_000;

  return {
    dueWakeupBatchSize,
    dueWakeupPollIntervalMillis,
    backgroundTaskShutdownTimeoutMillis,
  };
}
