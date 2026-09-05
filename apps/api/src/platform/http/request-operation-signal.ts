const EXTERNAL_OPERATION_TIMEOUT_MS = 30_000;

type AbortableRequest = Readonly<{
  raw?: Readonly<{
    destroyed?: boolean;
    once(event: 'aborted', listener: () => void): unknown;
    off(event: 'aborted', listener: () => void): unknown;
  }>;
}>;

export async function withRequestOperationSignal<T>(
  request: AbortableRequest,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const disconnected = new AbortController();
  const onAborted = (): void => {
    disconnected.abort(new DOMException('Request aborted', 'AbortError'));
  };
  request.raw?.once('aborted', onAborted);
  if (request.raw?.destroyed === true) onAborted();
  const signal = AbortSignal.any([
    disconnected.signal,
    AbortSignal.timeout(EXTERNAL_OPERATION_TIMEOUT_MS),
  ]);
  try {
    return await work(signal);
  } finally {
    request.raw?.off('aborted', onAborted);
  }
}
