import { sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { Pool, type PoolConfig } from 'pg';
import type { DatabasePoolRole } from '../policy.js';

import {
  type DatabasePoolDiagnostics,
  type MeterState,
  type LockWaitMonitor,
  safeDiagnostic,
} from './metrics.js';

export const cleanupError = (cause: unknown): Error =>
  new Error('Cleanup failed', { cause });

function startLockWaitMonitor(
  config: PoolConfig,
  state: MeterState,
  {
    intervalMs,
    backendPids,
    role,
    diagnostics,
  }: Readonly<{
    intervalMs: number;
    backendPids: Set<number>;
    role: DatabasePoolRole;
    diagnostics: DatabasePoolDiagnostics | undefined;
  }>,
): LockWaitMonitor {
  const monitorPool = new Pool({ ...config, max: 1 });
  const observations = new Map<
    number,
    { readonly firstObservedAt: number; lastObservedAt: number }
  >();
  let closed = false;
  let sampling = false;
  let samplePromise: Promise<void> | undefined;
  monitorPool.on('error', () => undefined);
  const monitor: LockWaitMonitor = {
    active: 0,
    backendPids,
    references: 1,
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      await samplePromise;
      await monitorPool.end();
    },
  };

  const sample = (): Promise<void> => {
    if (closed || sampling) return Promise.resolve();
    sampling = true;
    samplePromise = (async (): Promise<void> => {
      try {
        const query = new QueryBuilder()
          .select({ pid: sql<number>`pid`.as('pid') })
          .from(sql`pg_catalog.pg_stat_activity`)
          .where(
            sql`datname = current_database() and backend_type = 'client backend' and pid = any(${sql.param([...backendPids])}::integer[]) and wait_event_type = 'Lock'`,
          );
        const statement = query.toSQL();
        const result = await monitorPool.query<
          (typeof query)['_']['result'][number]
        >(statement.sql, statement.params);
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
          state.lockWaitDuration.record(
            (observation.lastObservedAt - observation.firstObservedAt) / 1_000,
            { outcome: 'completed' },
          );
          observations.delete(pid);
        }
      } catch (error: unknown) {
        monitor.active = 0;
        observations.clear();
        safeDiagnostic(diagnostics, 'lock_wait_sample', role, error);
        // A failed sample is unknown, not evidence that a prior wait is active.
      } finally {
        sampling = false;
      }
    })();
    return samplePromise;
  };

  const timer = setInterval(() => {
    void sample();
  }, intervalMs);
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

export function acquireLockWaitMonitor(
  config: PoolConfig,
  state: MeterState,
  {
    intervalMs,
    role,
    diagnostics,
  }: Readonly<{
    intervalMs: number;
    role: DatabasePoolRole;
    diagnostics: DatabasePoolDiagnostics | undefined;
  }>,
): Pick<LockWaitMonitor, 'backendPids' | 'close'> {
  const key = monitorKey(config, intervalMs, role);
  let monitor = state.monitors.get(key);
  if (monitor === undefined) {
    monitor = startLockWaitMonitor(config, state, {
      intervalMs,
      backendPids: new Set(),
      role,
      diagnostics,
    });
    state.monitors.set(key, monitor);
  } else {
    monitor.references += 1;
  }
  let releasePromise: Promise<void> | undefined;
  const release = async (): Promise<void> => {
    monitor.references -= 1;
    if (monitor.references > 0) return;
    state.monitors.delete(key);
    await monitor.close();
  };
  return Object.freeze({
    backendPids: monitor.backendPids,
    close: (): Promise<void> => {
      releasePromise ??= release();
      return releasePromise;
    },
  });
}
