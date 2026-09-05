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
  createCheckpoint,
  createCheckpointV2,
  createExecutableCompatibilityReleaseHistory,
  createExecutableCompatibilityReleaseSupport,
  verifyWorkflowExecutableV2,
} from '@pertexo/workflow-engine';

import { createTriggerReconciliationHandler } from './trigger-handler.js';
import {
  createTriggerRuntimeTelemetry,
  type TriggerRuntimeTelemetry,
} from './trigger-telemetry.js';
import { waitForSupervisorDelay } from '../runtime/abortable-delay.js';

export interface TriggerRuntime {
  readonly consumer: QueueConsumer;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

export type TriggerRuntimeOptions = Readonly<{
  batchSize: number;
  database: DatabaseConfig;
  databaseRuntime?: DatabaseRuntime;
  leaseDurationSeconds: number;
  leaseOwner: string;
  observer?: QueueConsumerObserver;
  pollIntervalMillis: number;
  redisUrl: string;
  releaseCohort: PlatformReleaseCohort;
}>;

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
    options.leaseOwner.length < 1 ||
    options.leaseOwner.length > 128
  )
    throw new TypeError('Trigger runtime scanner configuration is invalid');
}

export async function createTriggerRuntime(
  options: TriggerRuntimeOptions,
  dependencies: TriggerRuntimeDependencies = {},
): Promise<TriggerRuntime> {
  validateOptions(options);
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
      const engineVersion = 'phase3-engine-v1';
      return Object.freeze({
        engineVersion,
        checkpoint: (executable.envelope.graph.nodes.some(
          ({ definition }) =>
            (definition.key === 'core.condition' ||
              definition.key === 'core.switch' ||
              definition.key === 'core.parallel') &&
            definition.version === 1,
        )
          ? createCheckpointV2
          : createCheckpoint)({
          engineVersion,
          workflowVersionId: projection.id,
          iterationBudget: 1_000,
          nextEventSequence: 2,
        }),
      });
    });
  const reconciliation =
    dependencies.reconciliation ??
    createWorkflowTriggerReconciliationDatabase(
      options.database,
      options.databaseRuntime,
    );
  const reader =
    dependencies.reader ??
    createPublishedWorkflowReader(
      options.database,
      releaseSupport.descriptions,
      options.databaseRuntime,
    );
  const scanner =
    dependencies.scanner ??
    createScheduleTriggerScanner(
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
  let consumer: QueueConsumer;
  try {
    consumer = (dependencies.consumerFactory ?? createQueueConsumer)({
      queueName: QUEUE_NAME.triggerLifecycle,
      redisUrl: options.redisUrl,
      handler: async (delivery, context) => {
        if (delivery.name !== JOB_NAME.reconcileWorkflowTriggers)
          throw new InvalidQueueDeliveryError(
            `Trigger runtime cannot handle ${delivery.name}`,
          );
        try {
          await handler.handle(delivery, context);
          recordTelemetry(() => {
            telemetry.reconciliationCompleted('succeeded');
          });
        } catch (error: unknown) {
          recordTelemetry(() => {
            telemetry.reconciliationCompleted('failed');
          });
          throw error;
        }
      },
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      traceRunner: createQueueTraceRunner(),
    });
  } catch (error: unknown) {
    await Promise.allSettled([
      scanner.close(),
      reader.close(),
      reconciliation.close(),
    ]);
    throw error;
  }

  const scannerAbort = new AbortController();
  const telemetry = dependencies.telemetry ?? createTriggerRuntimeTelemetry();
  let latestScanFailed = false;
  const scannerLoop = (async () => {
    while (!scannerAbort.signal.aborted) {
      const started = performance.now();
      try {
        const result = await scanner.scanDue({
          leaseOwner: options.leaseOwner,
          limit: options.batchSize,
          leaseSeconds: options.leaseDurationSeconds,
          checkpointFactory,
          signal: scannerAbort.signal,
        });
        recordTelemetry(() => {
          telemetry.scanCompleted(
            result,
            Math.max(0, performance.now() - started) / 1_000,
          );
        });
        latestScanFailed = false;
      } catch (error: unknown) {
        recordTelemetry(() => {
          telemetry.scanFailed(
            Math.max(0, performance.now() - started) / 1_000,
          );
        });
        latestScanFailed = true;
        dependencies.logger?.error(
          'trigger.schedule_scan_failed',
          { safeErrorCode: 'trigger.schedule_scan_failed' },
          error,
        );
      }
      await waitForSupervisorDelay(
        options.pollIntervalMillis,
        scannerAbort.signal,
      );
    }
  })();
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    consumer,
    checkReadiness: () => {
      if (latestScanFailed)
        return Promise.reject(new Error('Schedule scanner latest scan failed'));
      return Promise.resolve();
    },
    close: () => {
      closePromise ??= (async () => {
        scannerAbort.abort();
        const consumerResult = await Promise.allSettled([consumer.close()]);
        const loopResult = await Promise.allSettled([scannerLoop]);
        const adaptersResult = await Promise.allSettled([
          scanner.close(),
          reader.close(),
          reconciliation.close(),
        ]);
        const failure = [
          ...consumerResult,
          ...loopResult,
          ...adaptersResult,
        ].find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      })();
      return closePromise;
    },
  });
}

function recordTelemetry(operation: () => void): void {
  try {
    operation();
  } catch {
    // Diagnostics cannot change schedule occurrence truth.
  }
}
