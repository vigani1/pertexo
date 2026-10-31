import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabasePool } from '../../../src/platform/pool/telemetry/create-pool.js';

const connectionString =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

const uncaught: unknown[] = [];
const recordUncaught = (error: unknown) => uncaught.push(error);
const admin = new Pool({ connectionString, max: 1 });

beforeAll(() => {
  process.on('uncaughtException', recordUncaught);
});

afterAll(async () => {
  process.off('uncaughtException', recordUncaught);
  await admin.end();
});

it('keeps the process and the pool alive when PostgreSQL ends a checked-out connection', async () => {
  const application = `connection-loss-${randomUUID()}`;
  const pool = createDatabasePool(
    { connectionString, application_name: application, max: 1 },
    { monitorLockWaits: false },
  );
  try {
    const client = await pool.connect();
    const ended = new Promise((resolve) => client.once('end', resolve));
    await admin.query(
      'select pg_terminate_backend(pid) from pg_stat_activity where application_name=$1',
      [application],
    );
    await ended;

    expect(uncaught).toEqual([]);
    await expect(client.query('select 1')).rejects.toThrow();
    client.release();
    expect((await pool.query('select 1 as alive')).rows).toEqual([
      { alive: 1 },
    ]);
  } finally {
    await pool.end();
  }
});
