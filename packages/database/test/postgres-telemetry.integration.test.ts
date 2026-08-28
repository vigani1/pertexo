import type { Meter } from '@opentelemetry/api';
import { expect, it } from 'vitest';

import {
  createDatabasePool,
  DATABASE_METRIC_NAME,
} from '../src/postgres-telemetry.js';

const databaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

function telemetryMeter(): {
  activeLockWait(): number | undefined;
  readonly lockWaitDurations: number[];
  readonly meter: Meter;
  readonly transactionOutcomes: string[];
} {
  const callbacks = new Map<
    string,
    (result: { observe(value: number): void }) => void
  >();
  const lockWaitDurations: number[] = [];
  const transactionOutcomes: string[] = [];
  const meter = {
    createHistogram(name: string) {
      return {
        record(value: number, attributes?: Record<string, string>) {
          if (name === DATABASE_METRIC_NAME.lockWaitDuration)
            lockWaitDurations.push(value);
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
  const owner = await pool.connect();
  const waiter = await pool.connect();
  const lockKey = 7_301_991;

  try {
    await owner.query('select pg_advisory_lock($1)', [lockKey]);
    const waiting = waiter.query('select pg_advisory_lock($1)', [lockKey]);
    await waitFor(() => telemetry.activeLockWait() === 1);
    await owner.query('select pg_advisory_unlock($1)', [lockKey]);
    await waiting;
    await waitFor(() => telemetry.lockWaitDurations.length === 1);

    expect(telemetry.activeLockWait()).toBe(0);
    expect(telemetry.lockWaitDurations[0]).toBeGreaterThanOrEqual(0);
  } finally {
    await owner.query('select pg_advisory_unlock_all()');
    await waiter.query('select pg_advisory_unlock_all()');
    owner.release();
    waiter.release();
    await pool.end();
  }
}, 10_000);

it('records a transaction abandoned through the real pool release seam', async () => {
  const telemetry = telemetryMeter();
  const pool = createDatabasePool(
    { connectionString: databaseUrl, max: 1 },
    { meter: telemetry.meter, monitorLockWaits: false },
  );
  const client = await pool.connect();
  try {
    await client.query('begin');
  } finally {
    client.release();
  }
  const reusedClient = await pool.connect();
  try {
    await reusedClient.query('begin');
  } finally {
    reusedClient.release();
    await pool.end();
  }
  expect(telemetry.transactionOutcomes).toEqual(['abandoned', 'abandoned']);
});
