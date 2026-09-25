import {
  createPublishedWorkflowReader,
  createScheduleTriggerScanner,
  createWorkflowTriggerReconciliationDatabase,
  type DatabaseConfig,
  type DatabaseRuntime,
  type PublishedWorkflowReader,
  type ScheduleCheckpointFactory,
  type ScheduleTriggerScanner,
  type WorkflowTriggerReconciliationDatabase,
} from '@pertexo/database/execution';
import {
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
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
import {
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseHistory,
  createExecutableCompatibilityReleaseSupport,
  verifyWorkflowExecutableV2,
} from '@pertexo/workflow-engine';

import { createTriggerReconciliationHandler } from './trigger-handler.js';
import {
  createTriggerRuntimeTelemetry,
  type TriggerRuntimeTelemetry,
} from './trigger-telemetry.js';
import { createWorkerInitialCheckpoint } from '../execution/core-definition-identities.js';
import {
  closeTriggerDependencies,
  createTriggerRuntimeLifecycle,
  recordTriggerTelemetry,
} from './trigger-runtime-lifecycle.js';

export interface TriggerRuntime {
  readonly consumer: QueueConsumer;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

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
  releaseCohort: PlatformReleaseCohort;
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
  checkpointFactory?: ScheduleCheckpointFactory;
  consumerFactory?: typeof createQueueConsumer;
  reader?: PublishedWorkflowReader;
  reconciliation?: WorkflowTriggerReconciliationDatabase;
  scanner?: ScheduleTriggerScanner;
  logger?: StructuredLogger;
  telemetry?: TriggerRuntimeTelemetry;
}>;

function validateOptions(options: TriggerRuntimeOptions): void {
  if (
    !Number.isSafeInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > 100 ||
    !Number.isSafeInteger(options.leaseDurationSeconds) ||
    options.leaseDurationSeconds < 1 ||
    options.leaseDurationSeconds > 300 ||
    !Number.isSafeInteger(options.pollIntervalMillis) ||
    options.pollIntervalMillis < 10 ||
    options.pollIntervalMillis > 60_000 ||
    !Number.isSafeInteger(options.onTimeWindowSeconds) ||
    options.onTimeWindowSeconds < 60 ||
    options.onTimeWindowSeconds > 3_600 ||
    (options.backgroundTaskShutdownTimeoutMillis !== undefined &&
      (!Number.isSafeInteger(options.backgroundTaskShutdownTimeoutMillis) ||
        options.backgroundTaskShutdownTimeoutMillis < 1 ||
        options.backgroundTaskShutdownTimeoutMillis > 120_000)) ||
    options.leaseOwner.length < 1 ||
    options.leaseOwner.length > 128
  )
    throw new TypeError('Trigger runtime scanner configuration is invalid');
}

export async function createTriggerRuntime(
  options: TriggerRuntimeOptions,
  dependencies: TriggerRuntimeDependencies = {},
  factories: TriggerCompositionFactories = productionFactories,
): Promise<TriggerRuntime> {
  validateOptions(options);
  const backgroundTaskShutdownTimeoutMillis =
    options.backgroundTaskShutdownTimeoutMillis ?? 5_000;
  const releaseHistory = createExecutableCompatibilityReleaseHistory(
    platformExecutableRegistryHistory(options.releaseCohort).map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const releaseSupport = createExecutableCompatibilityReleaseSupport(
    platformRegistryReleaseSupport(options.releaseCohort).map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const checkpointFactory: ScheduleCheckpointFactory =
    dependencies.checkpointFactory ??
    ((projection, currentCompatibilityRelease) => {
      const admissionDescription = releaseHistory.descriptions.find(
        ({ epoch }) => epoch === projection.compatibilityReleaseEpoch,
      );
      if (admissionDescription === undefined)
        throw new Error('Published schedule workflow is not executable');
      const executable = verifyWorkflowExecutableV2({
        envelope: projection.executableJson,
        checksum: projection.checksum,
        admissionRelease: releaseHistory.resolve(
          admissionDescription.epoch,
          admissionDescription.fingerprint,
        ),
        currentRelease: releaseHistory.resolve(
          currentCompatibilityRelease.epoch,
          currentCompatibilityRelease.fingerprint,
        ),
      });
      return createWorkerInitialCheckpoint(executable, projection.id);
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
      factories.reader(
        options.database,
        releaseSupport.descriptions,
        options.databaseRuntime,
      );
    scanner =
      dependencies.scanner ??
      factories.scanner(
        options.database,
        releaseSupport.descriptions,
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
          recordTriggerTelemetry(() => {
            telemetry.reconciliationCompleted('succeeded');
          });
        } catch (error: unknown) {
          recordTriggerTelemetry(() => {
            telemetry.reconciliationCompleted('failed');
          });
          throw error;
        }
      },
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      traceRunner,
    });
  } catch (error: unknown) {
    const cleanup = await closeTriggerDependencies(
      {
        scanner,
        reader,
        reconciliation,
      },
      backgroundTaskShutdownTimeoutMillis,
    );
    if (cleanup.length > 0)
      throw new AggregateError(
        [error, ...cleanup],
        'Trigger runtime construction and cleanup failed',
      );
    throw error;
  }

  return createTriggerRuntimeLifecycle(
    { consumer, reader, reconciliation, scanner },
    {
      batchSize: options.batchSize,
      checkpointFactory,
      leaseDurationSeconds: options.leaseDurationSeconds,
      leaseOwner: options.leaseOwner,
      ...(dependencies.logger === undefined
        ? {}
        : { logger: dependencies.logger }),
      onTimeWindowSeconds: options.onTimeWindowSeconds,
      pollIntervalMillis: options.pollIntervalMillis,
      shutdownTimeoutMillis: backgroundTaskShutdownTimeoutMillis,
      telemetry,
    },
  );
}
