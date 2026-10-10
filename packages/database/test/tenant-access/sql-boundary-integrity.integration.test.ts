import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/migrations.js';
import { createDisposableDatabaseFixture } from '../support/postgres/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const databaseName = `pertexo_test_sql_boundary_${randomUUID().replaceAll('-', '')}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName,
  ownerRole: 'pertexo_owner',
});
const roleUrl = (environmentName: string, fallback: string): string =>
  fixture.databaseUrl(process.env[environmentName] ?? fallback);

const pools = {
  owner: new Pool({
    connectionString: roleUrl(
      'DATABASE_MIGRATION_URL',
      'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
    ),
    max: 1,
  }),
  dispatcher: new Pool({
    connectionString: roleUrl(
      'DATABASE_MAINTENANCE_URL',
      'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
    ),
    max: 1,
  }),
  worker: new Pool({
    connectionString: roleUrl(
      'DATABASE_URL',
      'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
    ),
    max: 1,
  }),
};

function hasCode(expected: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current: unknown = error;
    while (current instanceof Error) {
      if ((current as DatabaseError).code === expected) return true;
      current = current.cause;
    }
    return false;
  };
}

beforeAll(async () => {
  await fixture.create();
  await migrateDatabase({
    appRole: 'pertexo_app',
    connectionString: roleUrl(
      'DATABASE_MIGRATION_URL',
      'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
    ),
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
  });
});

afterAll(async () => {
  await Promise.all(Object.values(pools).map((pool) => pool.end()));
  await fixture.drop();
});

describe('SQL boundary integrity', () => {
  it('rejects malformed operator rows by exact constraint', async () => {
    const client = await pools.dispatcher.connect();
    try {
      await client.query('begin');
      await client.query('savepoint malformed_operator');
      await expect(
        client.query(
          `insert into app.operator_commands(
            id,workspace_id,command_type,dry_run,request_fingerprint,status,
            outcome,result,completed_at
          ) values($1,$2,'purge.rerun',false,$3,'completed','not_found','{}',null)`,
          [randomUUID(), randomUUID(), 'e'.repeat(64)],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'operator_commands_completion_order',
      });
      await client.query('rollback to savepoint malformed_operator');
      await client.query('rollback');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  it('rejects NULL and out-of-range page bounds before privileged work', async () => {
    for (const value of [null, 0, -1, 1001]) {
      await expect(
        pools.dispatcher.query(
          'select app.recover_due_workflow_run_active_admissions($1)',
          [value],
        ),
      ).rejects.toSatisfy(hasCode('22023'));
    }
    for (const value of [1, 1000]) {
      await expect(
        pools.dispatcher.query(
          'select app.recover_due_workflow_run_active_admissions($1)',
          [value],
        ),
      ).resolves.toMatchObject({
        rows: [{ recover_due_workflow_run_active_admissions: 0 }],
      });
    }
  });

  it('rejects NULL schedule bounds without clearing a lease', async () => {
    for (const [limit, seconds] of [
      [null, 30],
      [0, 30],
      [101, 30],
      [1, null],
      [1, 0],
      [1, 301],
    ]) {
      await expect(
        pools.worker.query(
          "select * from app.claim_due_trigger_schedules('q10-worker',$1,$2)",
          [limit, seconds],
        ),
      ).rejects.toSatisfy(hasCode('22023'));
    }
    await expect(
      pools.worker.query(
        'select app.defer_trigger_schedule_claim($1,$2,null)',
        [randomUUID(), randomUUID()],
      ),
    ).rejects.toSatisfy(hasCode('22023'));
    await expect(
      pools.worker.query(
        "select * from app.claim_due_trigger_schedules('q10-worker',1,1)",
      ),
    ).resolves.toMatchObject({ rows: [] });
  });
});
