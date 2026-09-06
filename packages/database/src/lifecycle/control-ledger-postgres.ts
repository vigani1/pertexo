import { createDatabasePool } from '../platform/postgres-telemetry.js';
import type { PoolClient, QueryConfig, QueryResult } from 'pg';

import type { DatabaseConfig } from '../config.js';

const BACKEND_CANCELLATION_TIMEOUT_MS = 1_000;

export interface MaintenancePool {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export async function query<
  Row extends Record<string, unknown> = Record<string, unknown>,
>(
  client: PoolClient,
  text: string,
  values: readonly unknown[] = [],
  signal?: AbortSignal,
): Promise<QueryResult<Row>> {
  throwIfAborted(signal);
  let result: QueryResult<Row>;
  try {
    result = await client.query<Row>({
      text,
      values: [...values],
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error: unknown) {
    if (signal?.aborted === true) throw signal.reason;
    throw error;
  }
  throwIfAborted(signal);
  return result;
}

export async function acquirePoolClient(
  pool: MaintenancePool,
  signal?: AbortSignal,
): Promise<PoolClient> {
  const connection = pool.connect();
  if (signal === undefined) return connection;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort?.(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([connection, aborted]);
  } catch (error: unknown) {
    if (signal.aborted) {
      void connection.then(
        (client) => {
          client.release();
        },
        () => undefined,
      );
      throw signal.reason;
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function externalSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = (): void => {
      finish(() => {
        // AbortSignal reasons are intentionally preserved even when non-Error.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal.reason);
      });
    };
    operation.then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          // Preserve the adapter's rejection value unchanged.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        });
      },
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function cancelBackendQuery(
  config: DatabaseConfig,
  processId: number,
): Promise<void> {
  const cancellationPool = createDatabasePool({
    ...config,
    connectionTimeoutMillis: Math.min(
      config.connectionTimeoutMillis,
      BACKEND_CANCELLATION_TIMEOUT_MS,
    ),
    max: 1,
  });
  const signal = AbortSignal.timeout(BACKEND_CANCELLATION_TIMEOUT_MS);
  const cancellationQuery: QueryConfig<number[]> & {
    readonly signal: AbortSignal;
  } = {
    text: 'select pg_cancel_backend($1)',
    values: [processId],
    signal,
  };
  try {
    await raceWithSignal(cancellationPool.query(cancellationQuery), signal);
  } catch {
    // Backend cancellation is best effort; transaction rollback is authoritative.
  } finally {
    const endSignal = AbortSignal.timeout(BACKEND_CANCELLATION_TIMEOUT_MS);
    await raceWithSignal(cancellationPool.end(), endSignal).catch(
      () => undefined,
    );
  }
}
