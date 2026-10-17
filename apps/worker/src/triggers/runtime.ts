import type { InitialCheckpointFactory } from '@pertexo/database/runs';
import {
  createScheduleTriggerScanner,
  createTriggerEventScanner,
  type TriggerEventScanner,
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
  reconciliation: typeof createWorkflowTriggerReconciliationDatabase;
  scanner: typeof createScheduleTriggerScanner;
  coordination: typeof createTriggerEventScanner;
  telemetry: typeof createTriggerRuntimeTelemetry;
  traceRunner: typeof createQueueTraceRunner;
}>;

const productionFactories: TriggerCompositionFactories = {
  consumer: createQueueConsumer,
  reconciliation: createWorkflowTriggerReconciliationDatabase,
  scanner: createScheduleTriggerScanner,
  coordination: createTriggerEventScanner,
  telemetry: createTriggerRuntimeTelemetry,
  traceRunner: createQueueTraceRunner,
};

export type TriggerRuntimeDependencies = Readonly<{
  checkpointFactory?: InitialCheckpointFactory;
  consumerFactory?: typeof createQueueConsumer;
  reconciliation?: WorkflowTriggerReconciliationDatabase;
  scanner?: ScheduleTriggerScanner;
  coordination?: TriggerEventScanner;
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
  let scanner: ScheduleTriggerScanner | undefined;
  let coordination: TriggerEventScanner | undefined;
  let consumer: QueueConsumer | undefined;
  try {
    reconciliation =
      dependencies.reconciliation ??
      factories.reconciliation(options.database, options.databaseRuntime);
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
    coordination =
      dependencies.coordination ??
      factories.coordination(options.database, options.databaseRuntime);
    const handler = createTriggerReconciliationHandler({ reconciliation });
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
      [coordination, scanner, reconciliation],
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
  const eventScanner = coordination;
  return createScannerRuntime({
    name: 'Trigger',
    consumer,
    owners: [coordination, scanner, reconciliation],
    pollIntervalMillis: options.pollIntervalMillis,
    shutdownTimeoutMillis: backgroundTaskShutdownTimeoutMillis,
    scan: async (signal) => {
      const started = performance.now();
      const seconds = () => (performance.now() - started) / 1_000;
      const outcomes = await Promise.allSettled([
        scheduleScanner.scanDue({
          leaseOwner: options.leaseOwner,
          limit: options.batchSize,
          leaseSeconds: options.leaseDurationSeconds,
          onTimeWindowSeconds: options.onTimeWindowSeconds,
          checkpointFactory,
          signal,
        }),
        eventScanner.scanDue({
          limit: options.batchSize,
          checkpointFactory,
          signal,
        }),
      ]);
      const scheduled = outcomes[0];
      if (scheduled.status === 'fulfilled')
        reportDiagnostic(() => {
          telemetry.scanCompleted(scheduled.value, seconds());
        });
      else if (!signal.aborted)
        reportDiagnostic(() => {
          telemetry.scanFailed(seconds());
        });
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(failures, 'Trigger scan failed');
    },
    scanFailed: (error) => {
      dependencies.logger?.error(
        'trigger.scan_failed',
        { safeErrorCode: 'trigger.scan_failed' },
        error,
      );
    },
  });
}
