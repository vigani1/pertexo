import { testStackSetting } from '../../../../../infrastructure/testing/test-stack.mjs';
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, expect, it } from 'vitest';

import { createDatabasePool } from '../../../src/platform/pool/telemetry/create-pool.js';
import { checkClientConnection } from '../../../src/platform/index.js';

const connectionString = testStackSetting('DATABASE_MIGRATION_URL');

const admin = new Pool({ connectionString, max: 1 });

afterAll(async () => {
  await admin.end();
});

async function backendOf(application: string) {
  const result = await admin.query<{ pid: number }>(
    'select pid from pg_stat_activity where application_name=$1',
    [application],
  );
  return result.rows.map((row) => row.pid);
}

// pg warns once per process when a query queues behind another on one
// client; this file's first pooled query is where setup could cause that.
it('sets the client check before the first query, without queuing it behind', async () => {
  const warnings: string[] = [];
  const record = (warning: Error) => {
    warnings.push(warning.message);
  };
  process.on('warning', record);
  const pool = createDatabasePool(
    { connectionString, max: 1 },
    { monitorLockWaits: false },
  );
  try {
    const shown = await pool.query<{
      client_connection_check_interval: string;
    }>('show client_connection_check_interval');
    expect(shown.rows).toEqual([{ client_connection_check_interval: '1s' }]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(warnings).toEqual([]);
  } finally {
    process.off('warning', record);
    await pool.end();
  }
});

// An abort sends a CancelRequest and drops the socket. When the cancel lands
// before the backend has read the statement, it is ignored, and PostgreSQL
// doesn't look at the socket while a statement runs: the backend kept
// sleeping, holding its connection, for the statement's whole length (batch
// K: a retention teardown found it still there 10 s later).
it('ends a statement whose client has gone, with no cancel reaching it', async () => {
  const application = `abandoned-statement-${randomUUID()}`;
  const pool = createDatabasePool(
    { connectionString, application_name: application, max: 1 },
    { monitorLockWaits: false },
  );
  try {
    const client = await pool.connect();
    client.on('error', () => undefined);
    const sleeping = client.query('select pg_sleep(30)').catch(() => undefined);
    await expect.poll(() => backendOf(application)).toHaveLength(1);
    // Stand-in for a cancel that missed: the socket goes, nothing else.
    (
      client as PoolClient & { connection: { stream: { destroy(): void } } }
    ).connection.stream.destroy();
    await sleeping;
    client.release(true);
    await expect
      .poll(() => backendOf(application), { timeout: 5_000 })
      .toEqual([]);
  } finally {
    await pool.end();
  }
});

// Review of batch K, P3-5: Better Auth builds its own pg Pool, so it applies
// the check directly; its connections end abandoned statements the same way.
it('gives a pool built outside createDatabasePool the same check', async () => {
  const pool = new Pool({ connectionString, max: 1 });
  checkClientConnection(pool, () => undefined);
  try {
    const shown = await pool.query<{
      client_connection_check_interval: string;
    }>('show client_connection_check_interval');
    expect(shown.rows).toEqual([{ client_connection_check_interval: '1s' }]);
  } finally {
    await pool.end();
  }
});
