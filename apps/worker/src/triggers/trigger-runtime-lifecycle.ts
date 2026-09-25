import type {
  PublishedWorkflowReader,
  ScheduleCheckpointFactory,
  ScheduleTriggerScanner,
  WorkflowTriggerReconciliationDatabase,
} from '@pertexo/database/execution';
import type { StructuredLogger } from '@pertexo/observability';
import type { QueueConsumer } from '@pertexo/queue';

import { waitForSupervisorDelay } from '../runtime/abortable-delay.js';
import { boundedBackgroundTask } from '../runtime/background-task-deadline.js';
import { drainScannerActivity } from '../runtime/scanner-shutdown.js';
import type { TriggerRuntimeTelemetry } from './trigger-telemetry.js';
import type { TriggerRuntime } from './trigger-runtime.js';

export type TriggerRuntimeComposition = Readonly<{
  consumer: QueueConsumer;
  reader: PublishedWorkflowReader;
  reconciliation: WorkflowTriggerReconciliationDatabase;
  scanner: ScheduleTriggerScanner;
}>;

export type TriggerScannerLifecycleOptions = Readonly<{
  batchSize: number;
  checkpointFactory: ScheduleCheckpointFactory;
  leaseDurationSeconds: number;
  leaseOwner: string;
  logger?: StructuredLogger;
  onTimeWindowSeconds: number;
  pollIntervalMillis: number;
  shutdownTimeoutMillis: number;
  telemetry: TriggerRuntimeTelemetry;
}>;

export function createTriggerRuntimeLifecycle(
  composition: TriggerRuntimeComposition,
  options: TriggerScannerLifecycleOptions,
): TriggerRuntime {
  const scannerAbort = new AbortController();
  const firstScan = Promise.withResolvers<undefined>();
  let firstScanSettled = false;
  let latestScanFailed = true;
  let closed = false;
  const settleFirstScan = (): void => {
    if (firstScanSettled) return;
    firstScanSettled = true;
    firstScan.resolve(undefined);
  };
  const scannerLoop = runTriggerScanner(
    composition.scanner,
    options,
    scannerAbort.signal,
    (failed) => {
      if (!closed) latestScanFailed = failed;
      settleFirstScan();
    },
  );
  observeTask(scannerLoop);

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    consumer: composition.consumer,
    checkReadiness: async (): Promise<void> => {
      if (closed) throw new Error('Trigger runtime is closed');
      await firstScan.promise;
      // Close can begin while the first scan is awaiting I/O.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (closed) throw new Error('Trigger runtime is closed');
      if (latestScanFailed)
        throw new Error('Schedule scanner latest scan failed');
    },
    close: (): Promise<void> => {
      closePromise ??= closeTriggerRuntime(
        composition,
        scannerLoop,
        scannerAbort,
        settleFirstScan,
        () => {
          closed = true;
        },
        options.shutdownTimeoutMillis,
      );
      return closePromise;
    },
  });
}

async function runTriggerScanner(
  scanner: ScheduleTriggerScanner,
  options: TriggerScannerLifecycleOptions,
  signal: AbortSignal,
  recordResult: (failed: boolean) => void,
): Promise<void> {
  while (!signal.aborted) {
    const started = performance.now();
    try {
      const result = await scanner.scanDue({
        leaseOwner: options.leaseOwner,
        limit: options.batchSize,
        leaseSeconds: options.leaseDurationSeconds,
        onTimeWindowSeconds: options.onTimeWindowSeconds,
        checkpointFactory: options.checkpointFactory,
        signal,
      });
      recordTriggerTelemetry(() => {
        options.telemetry.scanCompleted(
          result,
          Math.max(0, performance.now() - started) / 1_000,
        );
      });
      recordResult(false);
    } catch (error: unknown) {
      // The signal can change while the scan is awaiting I/O.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!signal.aborted) {
        recordTriggerTelemetry(() => {
          options.telemetry.scanFailed(
            Math.max(0, performance.now() - started) / 1_000,
          );
        });
        recordResult(true);
        safeLogScanFailure(options.logger, error);
      } else {
        recordResult(false);
      }
    }
    await waitForSupervisorDelay(options.pollIntervalMillis, signal);
  }
}

async function closeTriggerRuntime(
  composition: TriggerRuntimeComposition,
  scannerLoop: Promise<void>,
  scannerAbort: AbortController,
  settleFirstScan: () => void,
  markClosed: () => void,
  shutdownTimeoutMillis: number,
): Promise<void> {
  markClosed();
  const activityResults = await drainScannerActivity({
    consumer: composition.consumer,
    observeDeferred: (activity) => {
      observeDeferredTriggerClose(activity, composition, shutdownTimeoutMillis);
    },
    scannerAbort,
    scannerLoop,
    settleFirstScan,
    timeoutMillis: shutdownTimeoutMillis,
  });
  const failures = [
    ...rejectedReasons(activityResults),
    ...(await closeTriggerDependencies(composition, shutdownTimeoutMillis)),
  ];
  if (failures.length > 0)
    throw new AggregateError(failures, 'Trigger runtime shutdown failed');
}

function observeDeferredTriggerClose(
  activity: Promise<readonly PromiseSettledResult<unknown>[]>,
  dependencies: TriggerCloseableDependencies,
  timeoutMillis: number,
): void {
  observeTask(
    activity.then(async (results) => {
      const failures = [
        ...rejectedReasons(results),
        ...(await closeTriggerDependencies(dependencies, timeoutMillis)),
      ];
      if (failures.length > 0)
        throw new AggregateError(failures, 'Trigger deferred shutdown failed');
    }),
  );
}

export type TriggerCloseableDependencies = Readonly<{
  scanner?: ScheduleTriggerScanner | undefined;
  reader?: PublishedWorkflowReader | undefined;
  reconciliation?: WorkflowTriggerReconciliationDatabase | undefined;
}>;

export async function closeTriggerDependencies(
  dependencies: TriggerCloseableDependencies,
  timeoutMillis?: number,
): Promise<readonly unknown[]> {
  const operations = [
    () => dependencies.scanner?.close(),
    () => dependencies.reader?.close(),
    () => dependencies.reconciliation?.close(),
  ].map((close) => {
    const operation = Promise.resolve().then(close);
    return timeoutMillis === undefined
      ? operation
      : boundedBackgroundTask(operation, timeoutMillis);
  });
  return rejectedReasons(await Promise.allSettled(operations));
}

export function recordTriggerTelemetry(operation: () => void): void {
  try {
    operation();
  } catch {
    // Diagnostics cannot change schedule occurrence truth.
  }
}

function safeLogScanFailure(
  logger: StructuredLogger | undefined,
  error: unknown,
): void {
  try {
    logger?.error(
      'trigger.schedule_scan_failed',
      { safeErrorCode: 'trigger.schedule_scan_failed' },
      error,
    );
  } catch {
    // Diagnostics cannot change schedule occurrence truth.
  }
}

function rejectedReasons(
  results: readonly PromiseSettledResult<unknown>[],
): readonly unknown[] {
  return results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
}

function observeTask(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}
