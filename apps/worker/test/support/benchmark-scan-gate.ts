export interface BenchmarkScanGate {
  readonly released: boolean;
  release(): void;
  wait(signal?: AbortSignal): Promise<void>;
}

function abortError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('Benchmark scan gate was aborted', { cause: reason });
}

export function createBenchmarkScanGate(blocked: boolean): BenchmarkScanGate {
  const release = Promise.withResolvers<undefined>();
  let released = !blocked;
  if (released) release.resolve(undefined);
  return Object.freeze({
    get released() {
      return released;
    },
    release(): void {
      if (released) return;
      released = true;
      release.resolve(undefined);
    },
    async wait(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted === true) throw abortError(signal.reason);
      if (signal === undefined) {
        await release.promise;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          signal.removeEventListener('abort', onAbort);
          reject(abortError(signal.reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        release.promise.then(
          () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(abortError(error));
          },
        );
      });
    },
  });
}
