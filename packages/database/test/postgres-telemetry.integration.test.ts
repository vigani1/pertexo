import { randomUUID } from 'node:crypto';

import type { Meter } from '@opentelemetry/api';
import type { PoolClient } from 'pg';
import { expect, it } from 'vitest';

import {
  createDatabasePool,
  DATABASE_METRIC_NAME,
} from '../src/platform/postgres-telemetry.js';

const databaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

function uniqueAdvisoryKey(): number {
  return Number.parseInt(randomUUID().slice(0, 8), 16) & 0x7fff_ffff;
}

function telemetryMeter(): {
  activeLockWait(): number | undefined;
  readonly lockWaitDurations: number[];
  readonly meter: Meter;
  readonly poolCheckoutDurations: number[];
  readonly transactionOutcomes: string[];
} {
  const callbacks = new Map<
    string,
    (result: { observe(value: number): void }) => void
  >();
  const lockWaitDurations: number[] = [];
  const poolCheckoutDurations: number[] = [];
  const transactionOutcomes: string[] = [];
  const meter = {
    createHistogram(name: string) {
      return {
        record(value: number, attributes?: Record<string, string>) {
          if (name === DATABASE_METRIC_NAME.lockWaitDuration)
            lockWaitDurations.push(value);
          if (
            name === DATABASE_METRIC_NAME.poolCheckoutDuration &&
            attributes?.outcome === 'success'
          )
            poolCheckoutDurations.push(value);
          if (
            name === DATABASE_METRIC_NAME.transactionDuration &&
            attributes?.outcome !== undefined
          )
            transactionOutcomes.push(attributes.outcome);
        },
      };
    },
    createObservableGauge(name: string) {
      return {
        addCallback(
          callback: (result: { observe(value: number): void }) => void,
        ) {
          callbacks.set(name, callback);
        },
      };
    },
  } as unknown as Meter;
  return {
    activeLockWait(): number | undefined {
      let value: number | undefined;
      callbacks.get(DATABASE_METRIC_NAME.lockWaitActive)?.({
        observe(observed) {
          value = observed;
        },
      });
      return value;
    },
    lockWaitDurations,
    meter,
    poolCheckoutDurations,
    transactionOutcomes,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('PostgreSQL telemetry observation timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

it('observes a real repository-owned PostgreSQL lock wait and completion', async () => {
  const telemetry = telemetryMeter();
  const pool = createDatabasePool(
    { connectionString: databaseUrl, max: 2 },
    { lockWaitSampleIntervalMs: 100, meter: telemetry.meter },
  );
  let owner: PoolClient | undefined;
  let waiter: PoolClient | undefined;
  let waiting: Promise<unknown> | undefined;
  const lockKey = uniqueAdvisoryKey();

  try {
    const acquiredOwner = await pool.connect();
    owner = acquiredOwner;
    const acquiredWaiter = await pool.connect();
    waiter = acquiredWaiter;
    await acquiredOwner.query('select pg_advisory_lock($1)', [lockKey]);
    const pendingWait = acquiredWaiter.query('select pg_advisory_lock($1)', [
      lockKey,
    ]);
    waiting = pendingWait;
    void pendingWait.catch(() => undefined);
    await waitFor(() => telemetry.activeLockWait() === 1);
    await acquiredOwner.query('select pg_advisory_unlock($1)', [lockKey]);
    await pendingWait;
    await waitFor(() => telemetry.lockWaitDurations.length === 1);

    expect(telemetry.activeLockWait()).toBe(0);
    expect(telemetry.lockWaitDurations[0]).toBeGreaterThanOrEqual(0);
  } finally {
    if (owner !== undefined) {
      await owner
        .query('select pg_advisory_unlock_all()')
        .catch(() => undefined);
      owner.release(true);
    }
    if (waiting !== undefined) await waiting.catch(() => undefined);
    if (waiter !== undefined) {
      await waiter
        .query('select pg_advisory_unlock_all()')
        .catch(() => undefined);
      waiter.release(true);
    }
    await pool.end();
  }
}, 10_000);

it('records a transaction abandoned through the real pool release seam', async () => {
  const telemetry = telemetryMeter();
  const pool = createDatabasePool(
    { connectionString: databaseUrl, max: 1 },
    { meter: telemetry.meter, monitorLockWaits: false },
  );
  let client: PoolClient | undefined;
  let reusedClient: PoolClient | undefined;
  try {
    const acquiredClient = await pool.connect();
    client = acquiredClient;
    await acquiredClient.query('begin');
    const firstIdentity = await acquiredClient.query<{ pid: number }>(
      'select pg_backend_pid() pid',
    );
    // Deliberately return an open transaction once to exercise abandonment and
    // prove the same backend is observed on the second checkout.
    acquiredClient.release();
    const firstBackend = firstIdentity.rows[0]?.pid;
    client = undefined;
    const acquiredReusedClient = await pool.connect();
    reusedClient = acquiredReusedClient;
    await acquiredReusedClient.query('begin');
    const reusedIdentity = await acquiredReusedClient.query<{ pid: number }>(
      'select pg_backend_pid() pid',
    );
    expect(reusedIdentity.rows[0]?.pid).toBe(firstBackend);
  } finally {
    client?.release(true);
    reusedClient?.release(true);
    await pool.end();
  }
  // The first ordinary release is the abandonment observation; the final
  // destructive release proves teardown does not return that transaction.
  expect(telemetry.transactionOutcomes).toEqual([
    'abandoned',
    'connection_error',
  ]);
});

it('measures real pool checkout contention', async () => {
  const telemetry = telemetryMeter();
  const pool = createDatabasePool(
    { connectionString: databaseUrl, max: 1 },
    { meter: telemetry.meter, monitorLockWaits: false },
  );
  let owner: PoolClient | undefined;
  let waiter: PoolClient | undefined;
  let waiting: Promise<PoolClient> | undefined;
  try {
    const acquiredOwner = await pool.connect();
    owner = acquiredOwner;
    const pendingCheckout = pool.connect();
    waiting = pendingCheckout;
    void pendingCheckout.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    acquiredOwner.release();
    owner = undefined;
    waiter = await pendingCheckout;
  } finally {
    owner?.release(true);
    waiter?.release(true);
    if (waiting !== undefined) await waiting.catch(() => undefined);
    await pool.end();
  }

  expect(telemetry.poolCheckoutDurations).toHaveLength(2);
  expect(telemetry.poolCheckoutDurations[1]).toBeGreaterThanOrEqual(0.04);
});
