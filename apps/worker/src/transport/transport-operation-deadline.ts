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
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TransportOperationTimeoutError(timeoutMillis));
    }, timeoutMillis);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        // Preserve even legacy non-Error rejections without inspecting them.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      },
    );
  });
}
