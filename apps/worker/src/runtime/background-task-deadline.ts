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
  const deadline = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    deadline.reject(timeoutError());
  }, timeoutMillis);
  timer.unref();
  return Promise.race([task, deadline.promise]).finally(() => {
    clearTimeout(timer);
  });
}
