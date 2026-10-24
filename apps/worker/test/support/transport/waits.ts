export function createTransportProofWaits(ownedDeferreds: Set<() => void>) {
  const deferred = (
    stage: string,
    timeoutMillis = 10_000,
  ): Readonly<{
    dispose(): void;
    promise: Promise<void>;
    reject(reason: unknown): void;
    resolve(): void;
  }> => {
    let resolvePromise: (() => void) | undefined;
    let rejectPromise: ((reason: unknown) => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      ownedDeferreds.delete(dispose);
      operation();
    };
    const dispose = (): void => {
      settle(() => {
        resolvePromise?.();
      });
    };
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
      timer = setTimeout(() => {
        settle(() => {
          reject(new Error(`Worker transport stage timed out: ${stage}`));
        });
      }, timeoutMillis);
      timer.unref();
    });
    ownedDeferreds.add(dispose);
    return {
      dispose,
      promise,
      reject: (reason) => {
        settle(() => {
          rejectPromise?.(reason);
        });
      },
      resolve: () => {
        settle(() => {
          resolvePromise?.();
        });
      },
    };
  };

  const bounded = async <T>(
    stage: string,
    operation: Promise<T>,
    timeoutMillis = 10_000,
  ): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Worker transport stage timed out: ${stage}`));
          }, timeoutMillis);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return { deferred, bounded };
}
