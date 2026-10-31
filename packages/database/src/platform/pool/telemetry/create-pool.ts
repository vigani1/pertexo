import { metrics } from '@opentelemetry/api';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { withDatabaseDeadlineBudget } from '../policy.js';
import { instrumentPoolCheckout } from '../checkout-telemetry.js';
import { surviveConnectionLoss } from '../connection-loss.js';
import {
  type DatabasePoolOptions,
  safeDiagnostic,
  stateFor,
} from './metrics.js';
import {
  instrumentClient,
  instrumentClientRelease,
} from './instrument-client.js';
import { cleanupError, acquireLockWaitMonitor } from './monitor-lock-waits.js';
export type { DatabasePoolRole } from '../policy.js';
export {
  DATABASE_METRIC_NAME,
  type DatabasePoolOptions,
  type DatabasePoolDiagnostics,
} from './metrics.js';
export function createDatabasePool(
  config: PoolConfig,
  options: DatabasePoolOptions = {},
): Pool {
  const intervalMs = options.lockWaitSampleIntervalMs ?? 5_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100)
    throw new RangeError(
      'lockWaitSampleIntervalMs must be a safe integer of at least 100',
    );
  const meter =
    options.meter ?? metrics.getMeter('@pertexo/database.postgres', '0.0.0');
  const state = stateFor(meter);
  const role = options.role ?? 'other';
  const boundedConfig = withDatabaseDeadlineBudget(config, role);
  const pool = new Pool(boundedConfig);
  surviveConnectionLoss(pool, (error) => {
    safeDiagnostic(options.diagnostics, 'idle_pool_error', role, error);
  });
  instrumentPoolCheckout(pool, state.poolCheckoutDuration, role, (client) => {
    instrumentClientRelease(client, state);
  });
  const monitor =
    options.monitorLockWaits === false
      ? undefined
      : acquireLockWaitMonitor(boundedConfig, state, {
          intervalMs,
          role,
          diagnostics: options.diagnostics,
        });
  const backendPids = monitor?.backendPids;
  state.pools.set(pool, role);
  pool.on('connect', (client) => {
    instrumentClient(client, state);
    const processId = (client as PoolClient & { processID?: number }).processID;
    if (processId !== undefined) {
      backendPids?.add(processId);
      client.once('end', () => backendPids?.delete(processId));
    }
  });
  const originalEnd = pool.end.bind(pool);
  let endPromise: Promise<void> | undefined;
  pool.end = (): Promise<void> => {
    endPromise ??= (async (): Promise<void> => {
      let poolEndFailed = false;
      let poolEndError: unknown;
      try {
        await originalEnd();
      } catch (error) {
        poolEndFailed = true;
        poolEndError = error;
      }
      state.pools.delete(pool);
      try {
        await monitor?.close();
      } catch (monitorCloseError) {
        if (poolEndFailed)
          throw new AggregateError(
            [poolEndError, monitorCloseError],
            'PostgreSQL pool and lock-wait monitor cleanup both failed',
          );
        throw cleanupError(monitorCloseError);
      }
      if (poolEndFailed) throw cleanupError(poolEndError);
    })();
    return endPromise;
  };
  return pool;
}
