import type {
  CoordinatorRunStore,
  DeadlineWakeupScanner,
  DueNodeWakeupScanner,
  PublishedWorkflowReader,
} from '@pertexo/database/execution';
import type { StructuredLogger } from '@pertexo/observability';
import type {
  QueueConsumer,
  RunEventNotificationPublisher,
} from '@pertexo/queue';

import { waitForSupervisorDelay } from '../runtime/abortable-delay.js';
import { boundedBackgroundTask } from '../runtime/background-task-deadline.js';
import { drainScannerActivity } from '../runtime/scanner-shutdown.js';
import type { CoordinatorRuntime } from './coordinator-runtime.js';

export type CoordinatorRuntimeComposition = Readonly<{
  consumer: QueueConsumer;
  deadlineWakeupScanner: DeadlineWakeupScanner;
  dueWakeupScanner: DueNodeWakeupScanner;
  notifications: RunEventNotificationPublisher;
  reader: PublishedWorkflowReader;
  runStore: CoordinatorRunStore;
}>;

type CoordinatorScannerOptions = Readonly<{
  batchSize: number;
  logger?: StructuredLogger;
  pollIntervalMillis: number;
  shutdownTimeoutMillis: number;
}>;

export function createCoordinatorRuntimeLifecycle(
  composition: CoordinatorRuntimeComposition,
  options: CoordinatorScannerOptions,
): CoordinatorRuntime {
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
  const scannerLoop = runCoordinatorScanners(
    composition,
    options,
    scannerAbort.signal,
    (failed) => {
      if (!closed) latestScanFailed = failed;
    },
    settleFirstScan,
  );
  observeTask(scannerLoop);

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    consumer: composition.consumer,
    checkReadiness: async (): Promise<void> => {
      if (closed) throw new Error('Coordinator runtime is closed');
      await firstScan.promise;
      // Close can begin while the first scan is awaiting I/O.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (closed) throw new Error('Coordinator runtime is closed');
      if (latestScanFailed)
        throw new Error('Coordinator wakeup scanner latest scan failed');
    },
    close: (): Promise<void> => {
      closePromise ??= closeCoordinatorRuntime(
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

async function runCoordinatorScanners(
  composition: CoordinatorRuntimeComposition,
  options: CoordinatorScannerOptions,
  signal: AbortSignal,
  recordResult: (failed: boolean) => void,
  settleFirstScan: () => void,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await composition.dueWakeupScanner.claimDueWakeups(
        options.batchSize,
        signal,
      );
      // The signal can change while the scanner promise is awaiting I/O.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) return;
      await composition.deadlineWakeupScanner.claimDueWakeups(
        options.batchSize,
        signal,
      );
      recordResult(false);
    } catch (error: unknown) {
      // A transient database outage must not terminate the coordinator process.
      // The signal can change while either scanner is awaiting I/O.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!signal.aborted) {
        recordResult(true);
        safeLogScanFailure(options.logger, error);
      }
    } finally {
      settleFirstScan();
    }
    await waitForSupervisorDelay(options.pollIntervalMillis, signal);
  }
}

async function closeCoordinatorRuntime(
  composition: CoordinatorRuntimeComposition,
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
      observeDeferredCoordinatorClose(
        activity,
        composition,
        shutdownTimeoutMillis,
      );
    },
    scannerAbort,
    scannerLoop,
    settleFirstScan,
    timeoutMillis: shutdownTimeoutMillis,
  });
  const failures = [
    ...rejectedReasons(activityResults),
    ...(await closeCoordinatorDependencies(composition, shutdownTimeoutMillis)),
  ];
  if (failures.length > 0)
    throw new AggregateError(failures, 'Coordinator runtime shutdown failed');
}

function observeDeferredCoordinatorClose(
  activity: Promise<readonly PromiseSettledResult<unknown>[]>,
  dependencies: CoordinatorCloseableDependencies,
  timeoutMillis: number,
): void {
  observeTask(
    activity.then(async (results) => {
      const failures = [
        ...rejectedReasons(results),
        ...(await closeCoordinatorDependencies(dependencies, timeoutMillis)),
      ];
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          'Coordinator deferred shutdown failed',
        );
    }),
  );
}

export type CoordinatorCloseableDependencies = Readonly<{
  deadlineWakeupScanner?: DeadlineWakeupScanner | undefined;
  dueWakeupScanner?: DueNodeWakeupScanner | undefined;
  notifications?: RunEventNotificationPublisher | undefined;
  reader?: PublishedWorkflowReader | undefined;
  runStore?: CoordinatorRunStore | undefined;
}>;

export async function closeCoordinatorDependencies(
  dependencies: CoordinatorCloseableDependencies,
  timeoutMillis?: number,
): Promise<readonly unknown[]> {
  const operations = [
    () => dependencies.dueWakeupScanner?.close(),
    () => dependencies.deadlineWakeupScanner?.close(),
    () => dependencies.notifications?.close(),
    () => dependencies.reader?.close(),
    () => dependencies.runStore?.close(),
  ].map((close) => {
    const operation = Promise.resolve().then(close);
    return timeoutMillis === undefined
      ? operation
      : boundedBackgroundTask(operation, timeoutMillis);
  });
  return rejectedReasons(await Promise.allSettled(operations));
}

function safeLogScanFailure(
  logger: StructuredLogger | undefined,
  error: unknown,
): void {
  try {
    logger?.error(
      'coordinator.wakeup_scan_failed',
      { safeErrorCode: 'coordinator.wakeup_scan_failed' },
      error,
    );
  } catch {
    // Diagnostics cannot change durable wakeup recovery truth.
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
