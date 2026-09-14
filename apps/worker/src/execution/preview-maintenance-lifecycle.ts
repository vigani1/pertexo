import type {
  FailureNotificationStore,
  OperatorRunReplayStore,
} from '@pertexo/database/execution';
import type { QueueConsumer } from '@pertexo/queue';

import { waitForSupervisorDelay } from '../runtime/abortable-delay.js';
import { boundedBackgroundTask } from '../runtime/background-task-deadline.js';
import type { FailureNotificationHandler } from './failure-notification-handler.js';
import type { PreviewMaintenanceRuntime } from './preview-maintenance-runtime.js';
import type { PreviewReconciliationStore } from './preview-reconciliation-runtime.js';
import type { UnknownOutcomeReconciliationStore } from './unknown-outcome-reconciliation-runtime.js';

export type PreviewMaintenanceOwnedStores = Readonly<{
  reconciliationStore?:
    | (PreviewReconciliationStore & {
        close?: () => Promise<void>;
      })
    | undefined;
  failureNotificationStore?: FailureNotificationStore | undefined;
  unknownOutcomeStore?:
    | (UnknownOutcomeReconciliationStore & {
        close?: () => Promise<void>;
      })
    | undefined;
  runReplayStore?: OperatorRunReplayStore | undefined;
}>;

export type PreviewMaintenanceComposition = Readonly<{
  consumer: QueueConsumer;
  failureNotification?: FailureNotificationHandler;
  stores: PreviewMaintenanceOwnedStores;
}>;

export function createPreviewMaintenanceLifecycle(
  composition: PreviewMaintenanceComposition,
  shutdownTimeoutMillis: number,
): PreviewMaintenanceRuntime {
  let closePromise: Promise<void> | undefined;
  let rawActivity:
    Promise<readonly PromiseSettledResult<unknown>[]> | undefined;
  const recoveryAbort = new AbortController();
  const firstRecovery = Promise.withResolvers<undefined>();
  let firstRecoverySettled = false;
  let latestRecoveryFailed =
    composition.stores.failureNotificationStore !== undefined;
  let closed = false;
  const settleFirstRecovery = (): void => {
    if (firstRecoverySettled) return;
    firstRecoverySettled = true;
    firstRecovery.resolve(undefined);
  };
  if (composition.stores.failureNotificationStore === undefined)
    settleFirstRecovery();
  const recoveryLoop = startFailureNotificationRecovery(
    composition.stores.failureNotificationStore,
    recoveryAbort.signal,
    (failed) => {
      if (!closed) latestRecoveryFailed = failed;
      settleFirstRecovery();
    },
  );
  if (recoveryLoop !== undefined) observeTask(recoveryLoop);

  return Object.freeze({
    consumer: composition.consumer,
    checkReadiness: async (): Promise<void> => {
      if (closed) throw new Error('Preview maintenance runtime is closed');
      await firstRecovery.promise;
      // Close can begin while first recovery is awaiting I/O.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (closed) throw new Error('Preview maintenance runtime is closed');
      if (latestRecoveryFailed)
        throw new Error('Failure notification recovery latest scan failed');
    },
    whenIdle: async (): Promise<void> => {
      await rawActivity;
    },
    close: (): Promise<void> => {
      closePromise ??= (async (): Promise<void> => {
        closed = true;
        recoveryAbort.abort();
        settleFirstRecovery();
        const consumerActivity = drainMaintenanceConsumer(composition);
        rawActivity = Promise.allSettled([
          consumerActivity,
          ...(recoveryLoop === undefined ? [] : [recoveryLoop]),
        ]);
        let activityResults: Awaited<typeof rawActivity>;
        try {
          activityResults = await boundedBackgroundTask(
            rawActivity,
            shutdownTimeoutMillis,
          );
        } catch (error: unknown) {
          observeDeferredMaintenanceClose(
            rawActivity,
            composition.stores,
            shutdownTimeoutMillis,
          );
          throw error;
        }
        const failures = [
          ...rejectedReasons(activityResults),
          ...(await closePreviewMaintenanceDependencies(
            composition.stores,
            shutdownTimeoutMillis,
          )),
        ];
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            'Preview maintenance runtime shutdown failed',
          );
      })();
      return closePromise;
    },
  });
}

function startFailureNotificationRecovery(
  store: FailureNotificationStore | undefined,
  signal: AbortSignal,
  recordResult: (failed: boolean) => void,
): Promise<void> | undefined {
  if (store === undefined) return undefined;
  return (async (): Promise<void> => {
    while (!signal.aborted) {
      try {
        await store.recoverDue(25, 3, signal);
        recordResult(false);
      } catch {
        // The signal can change while recovery is awaiting I/O.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!signal.aborted) recordResult(true);
        else recordResult(false);
      }
      await waitForSupervisorDelay(1_000, signal);
    }
  })();
}

async function drainMaintenanceConsumer(
  composition: PreviewMaintenanceComposition,
): Promise<void> {
  const closeResults = await Promise.allSettled([
    Promise.resolve().then(() => composition.consumer.close()),
  ]);
  const pendingResults = await Promise.allSettled(
    composition.failureNotification?.pendingOperations() ?? [],
  );
  const failures = rejectedReasons([...closeResults, ...pendingResults]);
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'Preview maintenance consumer drain failed',
    );
}

function observeDeferredMaintenanceClose(
  activity: Promise<readonly PromiseSettledResult<unknown>[]>,
  stores: PreviewMaintenanceOwnedStores,
  shutdownTimeoutMillis: number,
): void {
  observeTask(
    activity.then(async (results) => {
      const failures = [
        ...rejectedReasons(results),
        ...(await closePreviewMaintenanceDependencies(
          stores,
          shutdownTimeoutMillis,
        )),
      ];
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          'Preview maintenance deferred shutdown failed',
        );
    }),
  );
}

export async function closePreviewMaintenanceDependencies(
  dependencies: PreviewMaintenanceOwnedStores,
  timeoutMillis?: number,
): Promise<readonly unknown[]> {
  const operations = [
    () => dependencies.reconciliationStore?.close?.(),
    () => dependencies.unknownOutcomeStore?.close?.(),
    () => dependencies.runReplayStore?.close(),
    () => dependencies.failureNotificationStore?.close(),
  ].map((close) => {
    const operation = Promise.resolve().then(close);
    return timeoutMillis === undefined
      ? operation
      : boundedBackgroundTask(operation, timeoutMillis);
  });
  return rejectedReasons(await Promise.allSettled(operations));
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
