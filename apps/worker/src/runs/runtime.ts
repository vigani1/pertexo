import {
  createWorkflowTestSuiteScanner,
  type WorkflowTestSuiteScanner,
} from '@pertexo/database/previews';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/outbox';
import {
  CoordinatorDeliveryMismatchError,
  CoordinatorRunStateCorruptError,
  createRunFailureStore,
  createDueNodeWakeupScanner,
  createDeadlineWakeupScanner,
  createRunAdvanceStore,
  createWorkflowCallStore,
  type DueNodeWakeupScanner,
  type DeadlineWakeupScanner,
  type RunAdvanceStore,
  type RunFailureStore,
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
  runFailures: typeof createRunFailureStore;
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
  runFailures: createRunFailureStore,
  callStore: createWorkflowCallStore,
  telemetry: createCoordinatorTelemetry,
  traceRunner: createQueueTraceRunner,
};

/** Shown on the run: the engine refused its stored state, so no retry can help. */
const UNADVANCEABLE_RUN_CODE = 'execution.run_state_invalid';
/** A few tries first, so a state that only looked wrong can't end a healthy run. */
const UNADVANCEABLE_AFTER_DELIVERIES = 4;

function queueHandler(
  handler: CoordinatorHandler,
  runFailures: RunFailureStore,
  logger: StructuredLogger | undefined,
): QueueJobHandler {
  return async (delivery, context): Promise<void> => {
    if (delivery.name !== JOB_NAME.advanceWorkflowRun) {
      throw new InvalidQueueDeliveryError(
        `Coordinator consumer cannot handle ${delivery.name}`,
      );
    }
    try {
      await handler.handle(delivery, context);
    } catch (error: unknown) {
      if (error instanceof CoordinatorDeliveryMismatchError)
        throw unrecoverableQueueError(
          'Coordinator delivery failed durable transport verification',
        );
      const unadvanceable =
        error instanceof CoordinatorRunStateCorruptError ||
        (error instanceof CoordinatorHandlerStateError &&
          error.code !== 'not_found');
      if (
        unadvanceable &&
        delivery.transport.attemptsMade + 1 < UNADVANCEABLE_AFTER_DELIVERIES
      )
        throw error;
      if (unadvanceable) {
        const ended = await runFailures.failUnadvanceable({
          workspaceId: delivery.data.workspaceId,
          runId: delivery.data.runId,
          safeErrorCode: UNADVANCEABLE_RUN_CODE,
          delivery: {
            outboxEventId: delivery.data.outboxEventId,
            payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
          },
          signal: context.signal,
        });
        logger?.error('run_recovery.run_unadvanceable', {
          workspaceId: delivery.data.workspaceId,
          runId: delivery.data.runId,
          ended,
        });
      }
      if (error instanceof CoordinatorHandlerStateError || unadvanceable)
        throw unrecoverableQueueError(
          `Coordinator delivery is not recoverable: ${error.message}`,
        );
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
  let runFailures: RunFailureStore | undefined;
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
    runFailures = factories.runFailures(
      options.database,
      options.databaseRuntime,
    );
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
      handler: queueHandler(handler, runFailures, options.logger),
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
        runFailures,
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
      runFailures,
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
