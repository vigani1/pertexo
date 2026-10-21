type OwnedArtifactIterator = AsyncIterator<Uint8Array>;

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

export async function completeWithCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
  combinedFailureMessage: string,
): Promise<T> {
  let result: T | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (operationFailed)
      throw new AggregateError(
        [operationError, cleanupError],
        combinedFailureMessage,
      );
    throw cleanupError instanceof Error
      ? cleanupError
      : new Error('Artifact cleanup failed with a non-Error value', {
          cause: cleanupError,
        });
  }
  if (operationFailed)
    throw operationError instanceof Error
      ? operationError
      : new Error('Artifact operation failed with a non-Error value', {
          cause: operationError,
        });
  return result as T;
}

function requestIteratorReturn(
  iterator: OwnedArtifactIterator,
  current: Promise<IteratorResult<Uint8Array>> | undefined,
): Promise<IteratorResult<Uint8Array>> | undefined {
  const returnIterator = iterator.return?.bind(iterator);
  if (current !== undefined || returnIterator === undefined) return current;
  const requested = Promise.resolve().then(() => returnIterator());
  void requested.catch(() => undefined);
  return requested;
}

export async function consumeArtifactChunks(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  consume: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const iterator = body[Symbol.asyncIterator]();
  let iteratorDone = false;
  let iteratorReturn: Promise<IteratorResult<Uint8Array>> | undefined;
  const returnOnAbort = (): void => {
    iteratorReturn = requestIteratorReturn(iterator, iteratorReturn);
  };
  signal.addEventListener('abort', returnOnAbort, { once: true });
  await completeWithCleanup(
    async () => {
      for (;;) {
        const result = await iterator.next();
        if (result.done) {
          iteratorDone = true;
          assertNotAborted(signal);
          return;
        }
        const chunk = result.value;
        try {
          assertNotAborted(signal);
          await consume(chunk);
        } finally {
          chunk.fill(0);
        }
      }
    },
    async () => {
      signal.removeEventListener('abort', returnOnAbort);
      if (!iteratorDone)
        iteratorReturn = requestIteratorReturn(iterator, iteratorReturn);
      await iteratorReturn;
    },
    'Artifact source iteration and cancellation both failed',
  );
}
