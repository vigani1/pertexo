import { boundedBackgroundTask } from '../../runtime/background-task-deadline.js';

export class TransportOperationTimeoutError extends Error {
  public override readonly name = 'TransportOperationTimeoutError';

  public constructor(timeoutMillis: number) {
    super(`Transport operation exceeded ${String(timeoutMillis)}ms`);
  }
}

export function bounded<T>(
  promise: Promise<T>,
  timeoutMillis: number,
): Promise<T> {
  return boundedBackgroundTask(
    promise,
    timeoutMillis,
    () => new TransportOperationTimeoutError(timeoutMillis),
  );
}
