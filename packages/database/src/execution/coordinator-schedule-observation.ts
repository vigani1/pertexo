import type { Pool, PoolClient } from 'pg';

import { destroyCanceledPoolClient } from '../platform/pool-client-disposal.js';

const defaultObservationTimeoutMillis = 250;

function observationCanceledError(): Error {
  const error = new Error('Coordinator schedule observation canceled');
  error.name = 'AbortError';
  return error;
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error('Coordinator schedule observation failed', { cause: value });
}

function destroyClient(client: PoolClient, error: Error): void {
  try {
    destroyCanceledPoolClient(client, error);
  } catch {
    // The observation is diagnostic only. The shared disposal helper has
    // already attempted both pool removal and socket destruction.
  }
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Observes database time after a winning scheduled commit without extending
 * the durable operation indefinitely. Cancellation owns both pool checkout and
 * an active query; late settlement is observed after the client is discarded.
 */
export async function observeScheduleToStartSeconds(
  pool: Pool,
  scheduleDueAt: string,
  signal: AbortSignal,
  timeoutMillis = defaultObservationTimeoutMillis,
): Promise<number | undefined> {
  if (
    !Number.isSafeInteger(timeoutMillis) ||
    timeoutMillis < 1 ||
    timeoutMillis > 2_147_483_647
  )
    return undefined;
  const dueAtMillis = Date.parse(scheduleDueAt);
  if (!Number.isFinite(dueAtMillis)) return undefined;

  const canceledError = observationCanceledError();
  const timeout = AbortSignal.timeout(timeoutMillis);
  const cancellation = AbortSignal.any([signal, timeout]);
  if (isAborted(cancellation)) return undefined;

  let cancelWait: (() => void) | undefined;
  const canceled = new Promise<'canceled'>((resolve) => {
    cancelWait = () => {
      resolve('canceled');
    };
    cancellation.addEventListener('abort', cancelWait, { once: true });
  });
  const connection = Promise.resolve().then(() => pool.connect());
  try {
    const acquired = await Promise.race([
      connection.then((client) => ({ kind: 'client' as const, client })),
      canceled.then(() => ({ kind: 'canceled' as const })),
    ]);
    if (acquired.kind === 'canceled') {
      void connection.then(
        (client) => {
          destroyClient(client, canceledError);
        },
        () => undefined,
      );
      return undefined;
    }

    const client = acquired.client;
    if (isAborted(cancellation)) {
      destroyClient(client, canceledError);
      return undefined;
    }

    let query: Promise<Readonly<{ rows: readonly { observed_at: Date }[] }>>;
    try {
      query = client.query<{ observed_at: Date }>(
        'select clock_timestamp() observed_at',
      );
    } catch (error: unknown) {
      destroyClient(client, asError(error));
      return undefined;
    }
    const observed = await Promise.race([
      query.then(
        (result) => ({ kind: 'observed' as const, result }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      ),
      canceled.then(() => ({ kind: 'canceled' as const })),
    ]);
    if (observed.kind === 'canceled') {
      destroyClient(client, canceledError);
      void query.catch(() => undefined);
      return undefined;
    }
    if (observed.kind === 'failed') {
      destroyClient(client, asError(observed.error));
      return undefined;
    }
    if (isAborted(cancellation)) {
      destroyClient(client, canceledError);
      return undefined;
    }

    try {
      client.release();
    } catch {
      return undefined;
    }
    const observedAt = observed.result.rows[0]?.observed_at;
    const observedAtMillis = observedAt?.getTime();
    if (observedAtMillis === undefined || !Number.isFinite(observedAtMillis))
      return undefined;
    return (observedAtMillis - dueAtMillis) / 1_000;
  } catch {
    return undefined;
  } finally {
    if (cancelWait !== undefined)
      cancellation.removeEventListener('abort', cancelWait);
  }
}
