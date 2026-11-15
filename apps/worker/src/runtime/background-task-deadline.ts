import { BackgroundTaskShutdownTimeoutError } from './background-task.errors.js';

/** How long startup's key checks (callback, encryption) may take. */
export const STARTUP_VERIFICATION_TIMEOUT_MILLIS = 2 * 60_000;

/** How long a stopping runtime waits for its background work by default. */
export const BACKGROUND_TASK_SHUTDOWN_TIMEOUT_MILLIS = 5_000;

/** Settles with the task, or rejects with the timeout error once it is due. */
export function boundedBackgroundTask<T>(
  task: Promise<T>,
  timeoutMillis: number,
  timeoutError: () => Error = () =>
    new BackgroundTaskShutdownTimeoutError(timeoutMillis),
): Promise<T> {
  const deadline = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    deadline.reject(timeoutError());
  }, timeoutMillis);
  timer.unref();
  return Promise.race([task, deadline.promise]).finally(() => {
    clearTimeout(timer);
  });
}
