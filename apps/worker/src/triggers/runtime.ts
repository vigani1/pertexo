import {
  createPublishedWorkflowReader,
  type PublishedWorkflowReader,
  type InitialCheckpointFactory,
} from '@pertexo/database/runs';
import {
  createScheduleTriggerScanner,
  createWorkflowTriggerReconciliationDatabase,
  type ScheduleTriggerScanner,
  type WorkflowTriggerReconciliationDatabase,
} from '@pertexo/database/triggers';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createQueueTraceRunner } from '@pertexo/observability';
import type { StructuredLogger } from '@pertexo/observability';
import {
  createQueueConsumer,
  InvalidQueueDeliveryError,
  JOB_NAME,
  QUEUE_NAME,
  type QueueConsumer,
  type QueueConsumerObserver,
} from '@pertexo/queue';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';

import { createTriggerReconciliationHandler } from './handler.js';
import {
  createTriggerRuntimeTelemetry,
  type TriggerRuntimeTelemetry,
} from './telemetry.js';
import { initialCheckpointFactory } from '@pertexo/execution';
import { reportDiagnostic } from '../runtime/polling.js';
import {
  closeOwners,
  createScannerRuntime,
  type ScannerRuntime,
} from '../runtime/scanner.js';

export type TriggerRuntime = ScannerRuntime;

export type TriggerRuntimeOptions = Readonly<{
  batchSize: number;
  backgroundTaskShutdownTimeoutMillis?: number;
  database: DatabaseConfig;
  databaseRuntime?: DatabaseRuntime;
  leaseDurationSeconds: number;
  leaseOwner: string;
  observer?: QueueConsumerObserver;
  onTimeWindowSeconds: number;
  pollIntervalMillis: number;
  redisUrl: string;
}>;

export type TriggerCompositionFactories = Readonly<{
  consumer: typeof createQueueConsumer;
  reader: typeof createPublishedWorkflowReader;
  reconciliation: typeof createWorkflowTriggerReconciliationDatabase;
  scanner: typeof createScheduleTriggerScanner;
  telemetry: typeof createTriggerRuntimeTelemetry;
  traceRunner: typeof createQueueTraceRunner;
}>;

const productionFactories: TriggerCompositionFactories = {
  consumer: createQueueConsumer,
  reader: createPublishedWorkflowReader,
  reconciliation: createWorkflowTriggerReconciliationDatabase,
  scanner: createScheduleTriggerScanner,
  telemetry: createTriggerRuntimeTelemetry,
  traceRunner: createQueueTraceRunner,
};

export type TriggerRuntimeDependencies = Readonly<{
  checkpointFactory?: InitialCheckpointFactory;
  consumerFactory?: typeof createQueueConsumer;
  reader?: PublishedWorkflowReader;
  reconciliation?: WorkflowTriggerReconciliationDatabase;
  scanner?: ScheduleTriggerScanner;
  logger?: StructuredLogger;
  telemetry?: TriggerRuntimeTelemetry;
}>;

export async function createTriggerRuntime(
  options: TriggerRuntimeOptions,
  dependencies: TriggerRuntimeDependencies = {},
  factories: TriggerCompositionFactories = productionFactories,
): Promise<TriggerRuntime> {
  const backgroundTaskShutdownTimeoutMillis =
    options.backgroundTaskShutdownTimeoutMillis ?? 5_000;
  const checkpointFactory: InitialCheckpointFactory =
    dependencies.checkpointFactory ??
    initialCheckpointFactory({
      catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
    });
  // Telemetry owns no closeable resources. Construct it before acquiring the
  // database and queue owners so constructor failure cannot strand them.
  const telemetry = dependencies.telemetry ?? factories.telemetry();
  const traceRunner = factories.traceRunner();
  let reconciliation: WorkflowTriggerReconciliationDatabase | undefined;
  let reader: PublishedWorkflowReader | undefined;
  let scanner: ScheduleTriggerScanner | undefined;
  let consumer: QueueConsumer | undefined;
  try {
    reconciliation =
      dependencies.reconciliation ??
      factories.reconciliation(options.database, options.databaseRuntime);
    reader =
      dependencies.reader ??
      factories.reader(options.database, options.databaseRuntime);
    scanner =
      dependencies.scanner ??
      factories.scanner(
        options.database,
        options.database,
        options.databaseRuntime === undefined
          ? {}
          : {
              acceptance: options.databaseRuntime,
              claim: options.databaseRuntime,
            },
      );
    const handler = createTriggerReconciliationHandler({
      reader,
      reconciliation,
    });
    consumer = (dependencies.consumerFactory ?? factories.consumer)({
      queueName: QUEUE_NAME.triggerLifecycle,
      redisUrl: options.redisUrl,
      handler: async (delivery, context) => {
        if (delivery.name !== JOB_NAME.reconcileWorkflowTriggers)
          throw new InvalidQueueDeliveryError(
            `Trigger runtime cannot handle ${delivery.name}`,
          );
        try {
          await handler.handle(delivery, context);
          reportDiagnostic(() => {
            telemetry.reconciliationCompleted('succeeded');
          });
        } catch (error: unknown) {
          reportDiagnostic(() => {
            telemetry.reconciliationCompleted('failed');
          });
          throw error;
        }
      },
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      traceRunner,
    });
  } catch (error: unknown) {
    const cleanup = await closeOwners(
      [scanner, reader, reconciliation],
      backgroundTaskShutdownTimeoutMillis,
    );
    if (cleanup.length > 0)
      throw new AggregateError(
        [error, ...cleanup],
        'Trigger runtime construction and cleanup failed',
      );
    throw error;
  }

  const scheduleScanner = scanner;
  return createScannerRuntime({
    name: 'Trigger',
    consumer,
    owners: [scanner, reader, reconciliation],
    pollIntervalMillis: options.pollIntervalMillis,
    shutdownTimeoutMillis: backgroundTaskShutdownTimeoutMillis,
    scan: async (signal) => {
      const started = performance.now();
      const seconds = () => (performance.now() - started) / 1_000;
      try {
        const result = await scheduleScanner.scanDue({
          leaseOwner: options.leaseOwner,
          limit: options.batchSize,
          leaseSeconds: options.leaseDurationSeconds,
          onTimeWindowSeconds: options.onTimeWindowSeconds,
          checkpointFactory,
          signal,
        });
        reportDiagnostic(() => {
          telemetry.scanCompleted(result, seconds());
        });
      } catch (error: unknown) {
        if (!signal.aborted)
          reportDiagnostic(() => {
            telemetry.scanFailed(seconds());
          });
        throw error;
      }
    },
    scanFailed: (error) => {
      dependencies.logger?.error(
        'trigger.schedule_scan_failed',
        { safeErrorCode: 'trigger.schedule_scan_failed' },
        error,
      );
    },
  });
}
