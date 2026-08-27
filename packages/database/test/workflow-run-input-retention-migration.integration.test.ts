import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const databaseName = `pertexo_test_input_retention_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = (() => {
  const url = new URL(migrationBaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
})();
const migrationConfig = {
  connectionString: databaseUrl,
  ownerRole: 'pertexo_owner',
  apiRuntimeRole: 'pertexo_api',
  workerRuntimeRole: 'pertexo_worker',
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  operatorRole: 'pertexo_operator',
} as const;
const workspaceId = randomUUID();
const userId = randomUUID();
const runId = randomUUID();
const createdAt = new Date('2026-08-01T12:00:00.000Z');
let priorDirectory = '';
let owner: Pool | undefined;

async function asOwner<T>(operation: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = owner;
  if (pool === undefined) throw new Error('Owner pool is unavailable');
  await pool.query('begin');
  try {
    await pool.query('set local role pertexo_owner');
    await pool.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await operation(pool);
    await pool.query('commit');
    return result;
  } catch (error: unknown) {
    await pool.query('rollback').catch(() => undefined);
    throw error;
  }
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,pertexo_api,pertexo_worker,pertexo_dispatcher`,
    );
  } finally {
    await admin.end();
  }
  priorDirectory = await mkdtemp(
    '/private/var/folders/1b/2tzp51hj4wg0rcvmj2j_pwlh0000gn/T/opencode/input-retention-prior-',
  );
  for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
    if (/^\d{4}_.+\.sql$/u.test(name) && name < '0043_')
      await copyFile(
        path.join(MIGRATIONS_DIRECTORY, name),
        path.join(priorDirectory, name),
      );
  }
  const prior = await migrateDatabase(migrationConfig, priorDirectory);
  expect(prior.at(-1)).toBe('0042_worker_run_admission_lock.sql');
  const ownerPool = new Pool({ connectionString: databaseUrl, max: 1 });
  owner = ownerPool;
  await ownerPool.query('begin');
  await ownerPool.query('set local role pertexo_owner');
  await ownerPool.query("select set_config('app.workspace_id',$1,true)", [
    workspaceId,
  ]);
  await ownerPool.query(
    `insert into app.users(id,email,display_name) values($1,$2,'Retention fixture')`,
    [userId, `${userId}@example.test`],
  );
  await ownerPool.query(
    `insert into app.workspaces(id,name,slug,created_by)
     values($1,'Retention fixture',$2,$3)`,
    [workspaceId, `retention-${workspaceId}`, userId],
  );
  await ownerPool.query(
    'alter table app.workflow_runs no force row level security',
  );
  await ownerPool.query(
    `insert into app.workflow_runs
       (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,input_ref,created_at,updated_at)
     values($1,$2,$3,$4,'manual','queued',$5::jsonb,$6,$6)`,
    [
      runId,
      workspaceId,
      randomUUID(),
      randomUUID(),
      JSON.stringify({ schemaVersion: 1, kind: 'inline', value: 'retained' }),
      createdAt,
    ],
  );
  await ownerPool.query(
    'alter table app.workflow_runs force row level security',
  );
  await ownerPool.query('commit');
}, 120_000);

afterAll(async () => {
  await owner?.end();
  if (priorDirectory !== '')
    await rm(priorDirectory, { recursive: true, force: true });
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('workflow run input retention prior-head migration', () => {
  it('upgrades exact 0042 input rows and enforces expiry pairing and bounds', async () => {
    await copyFile(
      path.join(MIGRATIONS_DIRECTORY, '0043_workflow_run_input_retention.sql'),
      path.join(priorDirectory, '0043_workflow_run_input_retention.sql'),
    );
    await expect(
      migrateDatabase(migrationConfig, priorDirectory),
    ).resolves.toEqual(['0043_workflow_run_input_retention.sql']);
    const result = await asOwner((pool) =>
      pool.query<{
        input_ref: unknown;
        input_ref_expires_at: Date;
      }>(
        'select input_ref,input_ref_expires_at from app.workflow_runs where id=$1',
        [runId],
      ),
    );
    expect(result.rows).toEqual([
      {
        input_ref: { schemaVersion: 1, kind: 'inline', value: 'retained' },
        input_ref_expires_at: new Date(
          createdAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
        ),
      },
    ]);

    await expect(
      asOwner((pool) =>
        pool.query(
          `update app.workflow_runs set input_ref_expires_at=null where id=$1`,
          [runId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      asOwner((pool) =>
        pool.query(
          `update app.workflow_runs
            set input_ref_expires_at=created_at + interval '30 days 1 second'
          where id=$1`,
          [runId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
