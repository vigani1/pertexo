export const TIMED_OUT = Symbol('timed-out');

export function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT> {
  return new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve(TIMED_OUT);
    }, timeoutMs);
    timeout.unref();
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(
          error instanceof Error
            ? error
            : new Error('Bounded queue operation failed', { cause: error }),
        );
      },
    );
  });
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Queue handler was aborted', { cause: signal.reason });
}
