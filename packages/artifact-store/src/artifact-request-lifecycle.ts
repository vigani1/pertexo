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
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const normalizeFailure = (failure: unknown, message: string): Error => {
      try {
        if (failure instanceof Error) return failure;
      } catch {
        // Unknown provider and cancellation values may be hostile proxies.
      }
      return new Error(message, { cause: failure });
    };
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      complete();
    };
    const aborted = () => {
      const reason: unknown = signal.reason;
      settle(() => {
        reject(normalizeFailure(reason, 'Artifact operation aborted'));
      });
    };
    void operation.then(
      (value) => {
        settle(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        settle(() => {
          reject(normalizeFailure(error, 'Artifact operation failed'));
        });
      },
    );
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
