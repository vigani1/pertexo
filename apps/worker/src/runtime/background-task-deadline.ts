class BackgroundTaskShutdownTimeoutError extends Error {
  public override readonly name = 'BackgroundTaskShutdownTimeoutError';

  public constructor(timeoutMillis: number) {
    super(`Background task did not stop within ${String(timeoutMillis)}ms`);
  }
}

/** Settles with the task, or rejects with the timeout error once it is due. */
export function boundedBackgroundTask<T>(
  task: Promise<T>,
  timeoutMillis: number,
  timeoutError: () => Error = () =>
    new BackgroundTaskShutdownTimeoutError(timeoutMillis),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(timeoutError());
    }, timeoutMillis);
    timer.unref();
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        // Preserve the task's original rejection, including legacy non-Errors.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      },
    );
  });
}
