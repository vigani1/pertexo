/** Shared deadline/cancellation semantics for storage I/O and signing. */
export function requestSignal(
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([externalSignal, timeoutSignal]);
}

export function awaitWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new Error('Artifact operation aborted', { cause: reason }),
      );
    };
    signal.addEventListener('abort', aborted, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(
          error instanceof Error
            ? error
            : new Error('Artifact operation failed', { cause: error }),
        );
      },
    );
  });
}
