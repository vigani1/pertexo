const EXTERNAL_OPERATION_TIMEOUT_MS = 30_000;

type AbortableRequest = Readonly<{
  raw?: Readonly<{
    destroyed?: boolean;
    once(event: 'aborted', listener: () => void): unknown;
    off(event: 'aborted', listener: () => void): unknown;
    socket?: Readonly<{
      destroyed?: boolean;
      once(event: 'close', listener: () => void): unknown;
      off(event: 'close', listener: () => void): unknown;
    }>;
  }>;
}>;

export async function withRequestOperationSignal<T>(
  request: AbortableRequest,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const disconnected = new AbortController();
  const onDisconnected = (): void => {
    disconnected.abort(new DOMException('Request aborted', 'AbortError'));
  };
  request.raw?.once('aborted', onDisconnected);
  request.raw?.socket?.once('close', onDisconnected);
  if (request.raw?.socket?.destroyed === true) onDisconnected();
  const signal = AbortSignal.any([
    disconnected.signal,
    AbortSignal.timeout(EXTERNAL_OPERATION_TIMEOUT_MS),
  ]);
  try {
    return await work(signal);
  } finally {
    request.raw?.off('aborted', onDisconnected);
    request.raw?.socket?.off('close', onDisconnected);
  }
}
