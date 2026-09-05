import { metrics, type Histogram, type Meter } from '@opentelemetry/api';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

export const DATABASE_METRIC_NAME = Object.freeze({
  lockWaitActive: 'pertexo.database.lock_wait.active',
  lockWaitDuration: 'pertexo.database.lock_wait.duration',
  poolConnections: 'pertexo.database.pool.connections',
  poolSaturation: 'pertexo.database.pool.saturation',
  poolWaiters: 'pertexo.database.pool.waiters',
  queryDuration: 'pertexo.database.query.duration',
  transactionDuration: 'pertexo.database.transaction.duration',
} as const);

export interface DatabasePoolOptions {
  /** Bounded, secret-free infrastructure failure reporting. */
  readonly diagnostics?: DatabasePoolDiagnostics;
  /** Injection seam for SDK-backed production meters and deterministic tests. */
  readonly meter?: Meter;
  /** Disable only when this process is not permitted to read pg_stat_activity. */
  readonly monitorLockWaits?: boolean;
  readonly lockWaitSampleIntervalMs?: number;
  /** Stable process authority; required for custom PostgreSQL role names. */
  readonly role?: DatabasePoolRole;
}

export interface DatabasePoolDiagnostics {
  record(event: DatabasePoolDiagnosticEvent): void;
}

type DatabasePoolDiagnosticEvent = Readonly<{
  operation: 'idle_pool_error' | 'lock_wait_sample';
  poolRole: DatabasePoolRole;
  errorType: string;
}>;

export type DatabasePoolRole =
  | 'api'
  | 'dispatcher'
  | 'lifecycle_command'
  | 'maintenance'
  | 'operator'
  | 'other'
  | 'worker';

type QueryOperation =
  | 'begin'
  | 'call'
  | 'commit'
  | 'copy'
  | 'delete'
  | 'insert'
  | 'other'
  | 'rollback'
  | 'select'
  | 'update';

interface MeterState {
  readonly pools: Map<Pool, DatabasePoolRole>;
  readonly monitors: Map<string, LockWaitMonitor>;
  readonly queryDuration: Histogram;
  readonly transactionDuration: Histogram;
  readonly lockWaitDuration: Histogram;
}

interface LockWaitMonitor {
  active: number;
  readonly backendPids: Set<number>;
  references: number;
  close(): Promise<void>;
}

const meterStates = new WeakMap<Meter, MeterState>();
const instrumentedClients = new WeakSet<PoolClient>();
const transactionStartedAtByClient = new WeakMap<PoolClient, number>();

function safeRecord(
  histogram: Histogram,
  value: number,
  attributes: Record<string, string>,
): void {
  try {
    histogram.record(value, attributes);
  } catch {
    // Observability must never affect a database operation's result.
  }
}

function safeDiagnostic(
  diagnostics: DatabasePoolDiagnostics | undefined,
  event: DatabasePoolDiagnosticEvent,
): void {
  try {
    diagnostics?.record(event);
  } catch {
    // Diagnostics must never affect database availability or shutdown.
  }
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function stateFor(meter: Meter): MeterState {
  const existing = meterStates.get(meter);
  if (existing !== undefined) return existing;

  const pools = new Map<Pool, DatabasePoolRole>();
  const monitors = new Map<string, LockWaitMonitor>();
  const connections = meter.createObservableGauge(
    DATABASE_METRIC_NAME.poolConnections,
    {
      description: 'Open connections across repository-owned PostgreSQL pools',
      unit: '{connection}',
    },
  );
  const saturation = meter.createObservableGauge(
    DATABASE_METRIC_NAME.poolSaturation,
    {
      description:
        'Checked-out connection share across repository-owned PostgreSQL pools',
      unit: '1',
    },
  );
  const waiters = meter.createObservableGauge(
    DATABASE_METRIC_NAME.poolWaiters,
    {
      description:
        'Callers waiting for a connection across repository-owned PostgreSQL pools',
      unit: '{request}',
    },
  );
  const lockWaitActive = meter.createObservableGauge(
    DATABASE_METRIC_NAME.lockWaitActive,
    {
      description:
        'Lock-waiting client backends visible in the latest pg_stat_activity samples',
      unit: '{connection}',
    },
  );

  connections.addCallback((result) => {
    for (const role of databasePoolRoles) {
      let count = 0;
      let present = false;
      for (const [pool, poolRole] of pools) {
        if (poolRole !== role) continue;
        present = true;
        count += pool.totalCount;
      }
      if (present) result.observe(count, { pool_role: role });
    }
  });
  saturation.addCallback((result) => {
    for (const role of databasePoolRoles) {
      let active = 0;
      let capacity = 0;
      let present = false;
      for (const [pool, poolRole] of pools) {
        if (poolRole !== role) continue;
        present = true;
        capacity += pool.options.max;
        active += pool.totalCount - pool.idleCount;
      }
      if (present)
        result.observe(capacity === 0 ? 0 : active / capacity, {
          pool_role: role,
        });
    }
  });
  waiters.addCallback((result) => {
    for (const role of databasePoolRoles) {
      let count = 0;
      let present = false;
      for (const [pool, poolRole] of pools) {
        if (poolRole !== role) continue;
        present = true;
        count += pool.waitingCount;
      }
      if (present) result.observe(count, { pool_role: role });
    }
  });
  lockWaitActive.addCallback((result) => {
    let count = 0;
    for (const monitor of monitors.values()) count += monitor.active;
    result.observe(count);
  });

  const state: MeterState = {
    pools,
    monitors,
    queryDuration: meter.createHistogram(DATABASE_METRIC_NAME.queryDuration, {
      description: 'PostgreSQL query duration by bounded operation and outcome',
      unit: 's',
    }),
    transactionDuration: meter.createHistogram(
      DATABASE_METRIC_NAME.transactionDuration,
      {
        description: 'PostgreSQL transaction duration by bounded outcome',
        unit: 's',
      },
    ),
    lockWaitDuration: meter.createHistogram(
      DATABASE_METRIC_NAME.lockWaitDuration,
      {
        description:
          'Completed lower-bound duration continuously observed by pg_stat_activity lock-wait sampling',
        unit: 's',
      },
    ),
  };
  meterStates.set(meter, state);
  return state;
}

const databasePoolRoles: readonly DatabasePoolRole[] = [
  'api',
  'dispatcher',
  'lifecycle_command',
  'maintenance',
  'operator',
  'other',
  'worker',
];

function databasePoolRole(config: PoolConfig): DatabasePoolRole {
  let user = config.user;
  if (user === undefined && config.connectionString !== undefined) {
    try {
      user = decodeURIComponent(new URL(config.connectionString).username);
    } catch {
      return 'other';
    }
  }
  switch (user) {
    case 'pertexo_api':
      return 'api';
    case 'pertexo_dispatcher':
      return 'dispatcher';
    case 'pertexo_lifecycle_command':
      return 'lifecycle_command';
    case 'pertexo_maintenance':
      return 'maintenance';
    case 'pertexo_operator':
      return 'operator';
    case 'pertexo_worker':
      return 'worker';
    default:
      return 'other';
  }
}

function queryText(query: unknown): string | undefined {
  if (typeof query === 'string') return query;
  if (
    typeof query === 'object' &&
    query !== null &&
    'text' in query &&
    typeof query.text === 'string'
  )
    return query.text;
  return undefined;
}

function queryOperation(query: unknown): QueryOperation {
  const keyword = /^\s*([a-z]+)/i
    .exec(queryText(query) ?? '')?.[1]
    ?.toLowerCase();
  if (keyword === 'start') return 'begin';
  if (
    keyword === 'begin' ||
    keyword === 'call' ||
    keyword === 'commit' ||
    keyword === 'copy' ||
    keyword === 'delete' ||
    keyword === 'insert' ||
    keyword === 'rollback' ||
    keyword === 'select' ||
    keyword === 'update'
  )
    return keyword;
  return 'other';
}

function instrumentClient(client: PoolClient, state: MeterState): void {
  if (instrumentedClients.has(client)) return;
  instrumentedClients.add(client);

  const originalQuery = client.query.bind(client);
  const finishTransaction = (
    outcome: 'abandoned' | 'committed' | 'connection_error' | 'rolled_back',
  ): void => {
    const transactionStartedAt = transactionStartedAtByClient.get(client);
    if (transactionStartedAt === undefined) return;
    safeRecord(
      state.transactionDuration,
      (performance.now() - transactionStartedAt) / 1_000,
      { outcome },
    );
    transactionStartedAtByClient.delete(client);
  };
  client.query = ((...args: unknown[]) => {
    const operation = queryOperation(args[0]);
    const startedAt = performance.now();
    let recorded = false;
    const finish = (outcome: 'error' | 'success'): void => {
      if (recorded) return;
      recorded = true;
      const finishedAt = performance.now();
      safeRecord(state.queryDuration, (finishedAt - startedAt) / 1_000, {
        operation,
        outcome,
      });

      if (operation === 'begin' && outcome === 'success') {
        transactionStartedAtByClient.set(client, startedAt);
      } else if (
        transactionStartedAtByClient.has(client) &&
        (operation === 'commit' || operation === 'rollback')
      ) {
        finishTransaction(
          outcome === 'error'
            ? 'connection_error'
            : operation === 'commit'
              ? 'committed'
              : 'rolled_back',
        );
      }
    };

    const callbackIndex =
      typeof args.at(-1) === 'function' ? args.length - 1 : undefined;
    if (callbackIndex !== undefined) {
      const callback = args[callbackIndex] as (...values: unknown[]) => unknown;
      args[callbackIndex] = function (this: unknown, ...values: unknown[]) {
        finish(
          values[0] === null || values[0] === undefined ? 'success' : 'error',
        );
        return callback.apply(this, values);
      };
    }

    try {
      const result = (originalQuery as (...values: unknown[]) => unknown)(
        ...args,
      );
      if (callbackIndex !== undefined) return result;
      if (
        typeof result === 'object' &&
        result !== null &&
        'then' in result &&
        typeof result.then === 'function'
      ) {
        return Promise.resolve(result).then(
          (value: unknown) => {
            finish('success');
            return value;
          },
          (error: unknown) => {
            finish('error');
            throw error;
          },
        );
      }
      return result;
    } catch (error: unknown) {
      finish('error');
      throw error;
    }
  }) as typeof client.query;
  client.once('error', () => {
    finishTransaction('connection_error');
  });
  client.once('end', () => {
    finishTransaction('connection_error');
  });
}

function instrumentClientRelease(client: PoolClient, state: MeterState): void {
  const originalRelease = client.release.bind(client);
  client.release = (destroy?: boolean | Error): void => {
    const transactionStartedAt = transactionStartedAtByClient.get(client);
    if (transactionStartedAt !== undefined) {
      safeRecord(
        state.transactionDuration,
        (performance.now() - transactionStartedAt) / 1_000,
        { outcome: destroy ? 'connection_error' : 'abandoned' },
      );
      transactionStartedAtByClient.delete(client);
    }
    originalRelease(destroy);
  };
}

function instrumentPoolConnect(pool: Pool, state: MeterState): void {
  const originalConnect = pool.connect.bind(pool);
  const connect = (
    callback?: (
      error: Error | undefined,
      client: PoolClient | undefined,
      release: (destroy?: boolean | Error) => void,
    ) => void,
  ): unknown => {
    if (callback !== undefined) {
      originalConnect((error, client, release) => {
        if (client !== undefined) instrumentClientRelease(client, state);
        const done = (destroy?: boolean | Error): void => {
          if (client === undefined) release(destroy);
          else client.release(destroy);
        };
        callback.call(undefined, error, client, done);
      });
      return;
    }
    return originalConnect().then((client) => {
      instrumentClientRelease(client, state);
      return client;
    });
  };
  pool.connect = connect as typeof pool.connect;
}

function startLockWaitMonitor(
  config: PoolConfig,
  state: MeterState,
  intervalMs: number,
  backendPids: Set<number>,
  role: DatabasePoolRole,
  diagnostics: DatabasePoolDiagnostics | undefined,
): LockWaitMonitor {
  const monitorPool = new Pool({ ...config, max: 1 });
  const observations = new Map<
    number,
    { readonly firstObservedAt: number; lastObservedAt: number }
  >();
  let closed = false;
  let sampling = false;
  monitorPool.on('error', () => undefined);
  const monitor: LockWaitMonitor = {
    active: 0,
    backendPids,
    references: 1,
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      await monitorPool.end().catch(() => undefined);
    },
  };

  const sample = async (): Promise<void> => {
    if (closed || sampling) return;
    sampling = true;
    try {
      const result = await monitorPool.query<{ pid: number }>(
        `select pid
           from pg_catalog.pg_stat_activity
          where datname = current_database()
            and backend_type = 'client backend'
            and pid = any($1::integer[])
            and wait_event_type = 'Lock'`,
        [[...backendPids]],
      );
      const sampledAt = performance.now();
      const active = new Set(result.rows.map((row) => row.pid));
      monitor.active = active.size;
      for (const pid of active) {
        const observation = observations.get(pid);
        if (observation === undefined) {
          observations.set(pid, {
            firstObservedAt: sampledAt,
            lastObservedAt: sampledAt,
          });
        } else {
          observation.lastObservedAt = sampledAt;
        }
      }
      for (const [pid, observation] of observations) {
        if (active.has(pid)) continue;
        safeRecord(
          state.lockWaitDuration,
          (observation.lastObservedAt - observation.firstObservedAt) / 1_000,
          { outcome: 'completed' },
        );
        observations.delete(pid);
      }
    } catch (error: unknown) {
      monitor.active = 0;
      observations.clear();
      safeDiagnostic(diagnostics, {
        operation: 'lock_wait_sample',
        poolRole: role,
        errorType: errorType(error),
      });
      // A failed sample is unknown, not evidence that a prior wait is active.
    } finally {
      sampling = false;
    }
  };

  const timer = setInterval(() => void sample(), intervalMs);
  timer.unref();
  void sample();

  return monitor;
}

function monitorKey(
  config: PoolConfig,
  intervalMs: number,
  role: DatabasePoolRole,
): string {
  return JSON.stringify({
    connectionString: config.connectionString,
    database: config.database,
    host: config.host,
    port: config.port,
    user: config.user,
    intervalMs,
    role,
  });
}

function acquireLockWaitMonitor(
  config: PoolConfig,
  state: MeterState,
  intervalMs: number,
  role: DatabasePoolRole,
  diagnostics: DatabasePoolDiagnostics | undefined,
): LockWaitMonitor {
  const key = monitorKey(config, intervalMs, role);
  const existing = state.monitors.get(key);
  if (existing !== undefined) {
    existing.references += 1;
    return existing;
  }
  const monitor = startLockWaitMonitor(
    config,
    state,
    intervalMs,
    new Set(),
    role,
    diagnostics,
  );
  state.monitors.set(key, monitor);
  const close = monitor.close.bind(monitor);
  monitor.close = async (): Promise<void> => {
    monitor.references -= 1;
    if (monitor.references > 0) return;
    state.monitors.delete(key);
    await close();
  };
  return monitor;
}

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
  const role = options.role ?? databasePoolRole(config);
  const pool = new Pool(config);
  pool.on('error', (error) => {
    safeDiagnostic(options.diagnostics, {
      operation: 'idle_pool_error',
      poolRole: role,
      errorType: errorType(error),
    });
  });
  instrumentPoolConnect(pool, state);
  const monitor =
    options.monitorLockWaits === false
      ? undefined
      : acquireLockWaitMonitor(
          config,
          state,
          intervalMs,
          role,
          options.diagnostics,
        );
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
  pool.end = async (): Promise<void> => {
    try {
      await originalEnd();
    } finally {
      state.pools.delete(pool);
      await monitor?.close();
    }
  };
  return pool;
}
