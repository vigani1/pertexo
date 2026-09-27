import type {
  FailureNotificationStore,
  WorkspaceInvitationDeliveryStore,
} from '@pertexo/database/execution';
import type { AwsConnectionEnvelopeEncryptionRuntime } from '@pertexo/integrations/server';
import { boundedBackgroundTask } from '../runtime/background-task-deadline.js';
import type { MaintenanceRuntime } from '../maintenance/runtime.js';

export function wrapOwnedMaintenanceRuntime(
  runtime: MaintenanceRuntime,
  notificationStore: FailureNotificationStore | undefined,
  encryptionRuntime: AwsConnectionEnvelopeEncryptionRuntime | undefined,
  invitationStore: WorkspaceInvitationDeliveryStore | undefined,
  timeoutMillis: number,
): MaintenanceRuntime {
  if (
    notificationStore === undefined &&
    encryptionRuntime === undefined &&
    invitationStore === undefined
  )
    return runtime;
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    consumer: runtime.consumer,
    checkReadiness: () => runtime.checkReadiness(),
    whenIdle: () => runtime.whenIdle(),
    close: (): Promise<void> => {
      closePromise ??= (async (): Promise<void> => {
        const runtimeResult = await Promise.allSettled([
          Promise.resolve().then(() => runtime.close()),
        ]);
        const runtimeFailure = runtimeResult.flatMap((result) =>
          result.status === 'rejected' ? [result.reason as unknown] : [],
        );
        if (runtimeFailure.length > 0) {
          const deferredDependencies = runtime
            .whenIdle()
            .then(() =>
              closeDeliveryDependencies(
                notificationStore,
                encryptionRuntime,
                invitationStore,
                timeoutMillis,
              ),
            );
          let dependencyFailures: readonly unknown[];
          try {
            dependencyFailures = await boundedBackgroundTask(
              deferredDependencies,
              timeoutMillis,
            );
          } catch (error: unknown) {
            observeTask(
              deferredDependencies.then((failures) => {
                if (failures.length > 0)
                  throw new AggregateError(
                    failures,
                    'Maintenance deferred owner shutdown failed',
                  );
              }),
            );
            throw new AggregateError(
              [...runtimeFailure, error],
              'Maintenance owner shutdown failed',
            );
          }
          throw new AggregateError(
            [...runtimeFailure, ...dependencyFailures],
            'Maintenance owner shutdown failed',
          );
        }
        const dependencyFailures = await closeDeliveryDependencies(
          notificationStore,
          encryptionRuntime,
          invitationStore,
          timeoutMillis,
        );
        const failures = [...dependencyFailures];
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            'Maintenance owner shutdown failed',
          );
      })();
      return closePromise;
    },
  });
}

export async function closeDeliveryDependencies(
  notificationStore: FailureNotificationStore | undefined,
  encryptionRuntime: AwsConnectionEnvelopeEncryptionRuntime | undefined,
  invitationStore: WorkspaceInvitationDeliveryStore | undefined,
  timeoutMillis?: number,
): Promise<readonly unknown[]> {
  const operations = [
    Promise.resolve().then(() => notificationStore?.close()),
    Promise.resolve().then(() => encryptionRuntime?.close()),
    Promise.resolve().then(() => invitationStore?.close()),
  ].map((operation) =>
    timeoutMillis === undefined
      ? operation
      : boundedBackgroundTask(operation, timeoutMillis),
  );
  const results = await Promise.allSettled(operations);
  return results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
}

function observeTask(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}
