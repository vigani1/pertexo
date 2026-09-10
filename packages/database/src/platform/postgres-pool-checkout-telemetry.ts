import type { Histogram } from '@opentelemetry/api';
import type { Pool, PoolClient } from 'pg';

import type { DatabasePoolRole } from './postgres-pool-policy.js';

export function instrumentPoolCheckout(
  pool: Pool,
  histogram: Histogram,
  role: DatabasePoolRole,
  instrumentClientRelease: (client: PoolClient) => void,
): void {
  const originalConnect = pool.connect.bind(pool);
  const connect = (
    callback?: (
      error: Error | undefined,
      client: PoolClient | undefined,
      release: (destroy?: boolean | Error) => void,
    ) => void,
  ): unknown => {
    const startedAt = performance.now();
    const record = (outcome: 'error' | 'success'): void => {
      try {
        histogram.record((performance.now() - startedAt) / 1_000, {
          outcome,
          pool_role: role,
        });
      } catch {
        // Observability must never affect a database acquisition's result.
      }
    };
    if (callback !== undefined) {
      originalConnect((error, client, release) => {
        record(error === undefined ? 'success' : 'error');
        if (client !== undefined) instrumentClientRelease(client);
        const done = (destroy?: boolean | Error): void => {
          if (client === undefined) release(destroy);
          else client.release(destroy);
        };
        callback.call(undefined, error, client, done);
      });
      return;
    }
    return originalConnect().then(
      (client) => {
        record('success');
        instrumentClientRelease(client);
        return client;
      },
      (error: unknown) => {
        record('error');
        throw error;
      },
    );
  };
  pool.connect = connect as typeof pool.connect;
}
