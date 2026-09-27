import type { PoolClient } from 'pg';

function checkoutError(value: unknown, message: string): Error {
  try {
    if (value instanceof Error) return value;
  } catch {
    // Hostile rejection inspection cannot strand a checked-out client.
  }
  return new Error(message, { cause: value });
}

/** Owns only the abort/late-settlement race, not transaction cleanup policy. */
export async function acquireAbortablePoolClient(
  pool: Readonly<{ connect(): Promise<PoolClient> }>,
  signal: AbortSignal | undefined,
  abortReason: () => unknown,
  releaseLateClient: (client: PoolClient) => void,
): Promise<PoolClient> {
  // A caller can deliberately preserve a non-Error AbortSignal.reason.
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  if (signal?.aborted === true) return Promise.reject(abortReason());
  const pending = pool.connect();
  if (signal === undefined) return pending;

  return new Promise<PoolClient>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      try {
        // Preserve the caller's exact cancellation identity, even if it is not Error.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(abortReason());
      } catch (error: unknown) {
        reject(checkoutError(error, 'Pool checkout aborted'));
      }
    };
    pending.then(
      (client) => {
        if (settled) {
          try {
            releaseLateClient(client);
          } catch {
            // The caller has already received cancellation; avoid an
            // unhandled rejection from a late disposal attempt.
          }
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(client);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(checkoutError(error, 'Pool checkout failed'));
      },
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
