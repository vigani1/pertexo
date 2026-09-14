import type { Pool } from 'pg';

import type { DatabaseConfig } from '../config.js';
import {
  createDatabasePool,
  type DatabasePoolOptions,
} from './postgres-telemetry.js';

export interface DatabaseRuntime {
  close(): Promise<void>;
}

export type DatabaseRuntimeOptions = DatabasePoolOptions;

interface RuntimeState {
  authority: string;
  closed: boolean;
  pool: Pool;
}

const runtimeState = new WeakMap<DatabaseRuntime, RuntimeState>();

function authority(config: DatabaseConfig): string {
  return JSON.stringify({
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    max: config.max,
    ownerRole: config.ownerRole,
    workerRuntimeRole: config.workerRuntimeRole,
  });
}

export function createDatabaseRuntime(
  config: DatabaseConfig,
  options: DatabaseRuntimeOptions,
): DatabaseRuntime {
  const pool = createDatabasePool(config, options);
  const state: RuntimeState = {
    authority: authority(config),
    closed: false,
    pool,
  };
  let closePromise: Promise<void> | undefined;
  const runtime: DatabaseRuntime = Object.freeze({
    close: (): Promise<void> => {
      if (closePromise === undefined) {
        state.closed = true;
        closePromise = Promise.resolve().then(() => pool.end());
      }
      return closePromise;
    },
  });
  runtimeState.set(runtime, state);
  return runtime;
}

export type DatabasePoolLease = Readonly<{
  pool: Pool;
  close(): Promise<void>;
}>;

/** Internal repository seam: an injected runtime owns its pool and lifecycle. */
export function acquireDatabasePool(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
  options?: DatabasePoolOptions,
): DatabasePoolLease {
  if (runtime !== undefined) {
    const state = runtimeState.get(runtime);
    if (state === undefined)
      throw new TypeError('Database runtime was not created by this package');
    if (state.authority !== authority(config))
      throw new TypeError(
        'Database runtime authority does not match repository config',
      );
    if (state.closed)
      throw new TypeError('Database runtime is closed and cannot be acquired');
    return Object.freeze({
      pool: state.pool,
      close: () => Promise.resolve(),
    });
  }
  const pool = createDatabasePool(config, options);
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    pool,
    close: (): Promise<void> => {
      closePromise ??= Promise.resolve().then(() => pool.end());
      return closePromise;
    },
  });
}
