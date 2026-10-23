import type { Histogram, Meter } from '@opentelemetry/api';
import type { Pool } from 'pg';
import type { DatabasePoolRole } from '../policy.js';

export const DATABASE_METRIC_NAME = Object.freeze({
  lockWaitActive: 'pertexo.database.lock_wait.active',
  lockWaitDuration: 'pertexo.database.lock_wait.duration',
  poolConnections: 'pertexo.database.pool.connections',
  poolSaturation: 'pertexo.database.pool.saturation',
  poolCheckoutDuration: 'pertexo.database.pool.checkout.duration',
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
  errorType: 'Error' | 'NonError';
}>;

export interface MeterState {
  readonly pools: Map<Pool, DatabasePoolRole>;
  readonly monitors: Map<string, LockWaitMonitor>;
  readonly queryDuration: Histogram;
  readonly poolCheckoutDuration: Histogram;
  readonly transactionDuration: Histogram;
  readonly lockWaitDuration: Histogram;
}

export interface LockWaitMonitor {
  active: number;
  readonly backendPids: Set<number>;
  references: number;
  close(): Promise<void>;
}

const meterStates = new WeakMap<Meter, MeterState>();

export function safeDiagnostic(
  diagnostics: DatabasePoolDiagnostics | undefined,
  operation: DatabasePoolDiagnosticEvent['operation'],
  poolRole: DatabasePoolRole,
  error: unknown,
): void {
  try {
    diagnostics?.record({
      operation,
      poolRole,
      errorType: error instanceof Error ? 'Error' : 'NonError',
    });
  } catch {
    // Classification and reporting must not affect database availability.
  }
}

export function stateFor(meter: Meter): MeterState {
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
    poolCheckoutDuration: meter.createHistogram(
      DATABASE_METRIC_NAME.poolCheckoutDuration,
      {
        description:
          'Elapsed PostgreSQL pool checkout duration by authority and outcome',
        unit: 's',
      },
    ),
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
  'maintenance',
  'other',
  'worker',
];
