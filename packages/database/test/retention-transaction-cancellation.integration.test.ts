import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inRetentionTransaction } from '../src/lifecycle/retention-transaction.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const maintenanceUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
const databaseName = `pertexo_test_retention_abort_${randomUUID().replaceAll('-', '')}`;
const options = { lockTimeoutMs: 10_000, statementTimeoutMs: 15_000 };
function urlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}
let owner: Pool;
let maintenance: Pool;

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}"`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_maintenance`,
    );
  } finally {
    await admin.end();
  }
  owner = new Pool({ connectionString: urlFor(adminUrl), max: 2 });
  maintenance = new Pool({ connectionString: urlFor(maintenanceUrl), max: 1 });
  await owner.query(
    'create table public.retention_abort_proof(id integer primary key)',
  );
  await owner.query(
    'grant select, insert on public.retention_abort_proof to pertexo_maintenance',
  );
});

afterAll(async () => {
  await maintenance.end();
  await owner.end();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('retention transaction cancellation on the real PostgreSQL driver', () => {
  it('interrupts a blocked query, rolls back preceding writes and replaces the client', async () => {
    const blocker = await owner.connect();
    const controller = new AbortController();
    const reason = new Error('retention lease lost');
    let backendPid = 0;
    let aborted = false;
    try {
      await blocker.query('begin');
      await blocker.query('select pg_advisory_xact_lock(419083, 1)');
      const pending = inRetentionTransaction(
        maintenance,
        options,
        controller.signal,
        async (client) => {
          const pid = await client.query<{ pid: number }>(
            'select pg_backend_pid() pid',
          );
          backendPid = pid.rows[0]?.pid ?? 0;
          await client.query(
            'insert into public.retention_abort_proof values (1)',
          );
          await client.query('select pg_advisory_xact_lock(419083, 1)');
        },
      );
      // Attach the rejection handler before abort to avoid an unhandled rejection.
      const outcome = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      await expect
        .poll(
          async () => {
            const state = await owner.query<{ blocked: boolean }>(
              "select exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock') blocked",
              [backendPid],
            );
            return state.rows[0]?.blocked;
          },
          { timeout: 2_000 },
        )
        .toBe(true);
      const started = performance.now();
      controller.abort(reason);
      aborted = true;
      expect(await outcome).toBe(reason);
      expect(performance.now() - started).toBeLessThan(2_000);
      await blocker.query('rollback');
      await expect
        .poll(async () => {
          const state = await owner.query<{ present: boolean }>(
            'select exists(select 1 from pg_stat_activity where pid=$1) present',
            [backendPid],
          );
          return state.rows[0]?.present;
        })
        .toBe(false);
      const rows = await owner.query(
        'select * from public.retention_abort_proof',
      );
      expect(rows.rows).toEqual([]);
      await inRetentionTransaction(
        maintenance,
        options,
        undefined,
        async (client) => {
          const state = await client.query<{
            pid: number;
            workspace: string | null;
            actor: string | null;
          }>(
            "select pg_backend_pid() pid, current_setting('app.workspace_id',true) workspace, current_setting('app.actor_id',true) actor",
          );
          expect(state.rows[0]?.pid).not.toBe(backendPid);
          expect(state.rows[0]?.workspace ?? '').toBe('');
          expect(state.rows[0]?.actor ?? '').toBe('');
          await client.query(
            'insert into public.retention_abort_proof values (2)',
          );
        },
      );
      expect(
        (await owner.query('select * from public.retention_abort_proof')).rows,
      ).toEqual([{ id: 2 }]);
    } finally {
      if (!aborted) controller.abort(reason);
      await blocker.query('rollback');
      blocker.release();
    }
  }, 20_000);

  it('cancels pool acquisition before a busy client becomes available', async () => {
    const held = await maintenance.connect();
    const controller = new AbortController();
    const reason = new Error('retention shutdown');
    let invoked = false;
    let settled = false;
    try {
      const pending = inRetentionTransaction(
        maintenance,
        options,
        controller.signal,
        () => {
          invoked = true;
          return Promise.resolve();
        },
      );
      const outcome = pending.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      const started = performance.now();
      controller.abort(reason);
      await expect.poll(() => settled, { timeout: 1_000 }).toBe(true);
      expect(await outcome).toBe(reason);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(invoked).toBe(false);
    } finally {
      held.release();
    }
    await inRetentionTransaction(
      maintenance,
      options,
      undefined,
      async (client) => {
        expect((await client.query('select 1 value')).rows).toEqual([
          { value: 1 },
        ]);
      },
    );
  }, 5_000);
});
