import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const databaseName = `pertexo_test_vocabulary_${randomUUID().replaceAll('-', '')}`;
const database = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_api'],
  databaseName,
  ownerRole: 'pertexo_owner',
});
const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: database.databaseUrl(migrationBaseUrl),
  dispatcherRole: 'pertexo_dispatcher',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  maintenanceRole: 'pertexo_maintenance',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

beforeAll(database.create, 30_000);
afterAll(database.drop);

async function copyMigrationsBefore(directory: string, head: string) {
  const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
    (name) => /^\d{4}_.+\.sql$/u.test(name) && name < head,
  );
  await Promise.all(
    migrations.map((name) =>
      copyFile(
        path.join(MIGRATIONS_DIRECTORY, name),
        path.join(directory, name),
      ),
    ),
  );
}

async function seedWorkspaceVocabulary(
  pool: Pool,
  workspaceId: string,
  suffix: number,
) {
  const canceledRunId = randomUUID();
  const queuedRunId = randomUUID();
  const canceledCreatedAt = new Date(
    `2026-01-0${String(suffix)}T00:00:00.000Z`,
  );
  await pool.query('begin');
  try {
    await pool.query('set local role pertexo_api');
    await pool.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await pool.query(
      `insert into app.workflow_runs
         (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
          created_at,updated_at)
       values
         ($1,$3,$4,$5,'manual','cancelled',$7,$7),
         ($2,$3,$6,$5,'api','queued',$8,$8)`,
      [
        canceledRunId,
        queuedRunId,
        workspaceId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        canceledCreatedAt,
        new Date(canceledCreatedAt.getTime() + 1_000),
      ],
    );
    await pool.query(
      `insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload)
       values($1,$2,1,'run.accepted',$3::jsonb),
             ($1,$4,1,'run.started',$5::jsonb)`,
      [
        workspaceId,
        canceledRunId,
        JSON.stringify({ fixture: suffix, retained: 'accepted' }),
        queuedRunId,
        JSON.stringify({ fixture: suffix, retained: 'started' }),
      ],
    );
    await pool.query(
      `insert into app.idempotency_records
         (id,workspace_id,operation,scope,key_hash,request_hash,status,
          resource_id,result_ref,created_at,updated_at)
       values
         ($1,$3,'runs.create',$4,$5,$6,'claimed',$2,$7::jsonb,$9,$9),
         ($8,$3,'runs.create',$10,$11,$12,'completed',$2,$13::jsonb,$14,$14)`,
      [
        randomUUID(),
        canceledRunId,
        workspaceId,
        `claimed-${String(suffix)}`,
        String(suffix).repeat(64),
        String(suffix + 2).repeat(64),
        JSON.stringify({ marker: `claimed-${String(suffix)}` }),
        randomUUID(),
        canceledCreatedAt,
        `completed-${String(suffix)}`,
        String(suffix + 4).repeat(64),
        String(suffix + 6).repeat(64),
        JSON.stringify({ marker: `completed-${String(suffix)}` }),
        new Date(canceledCreatedAt.getTime() + 2_000),
      ],
    );
    await pool.query('commit');
    return { canceledCreatedAt, canceledRunId, queuedRunId };
  } catch (error: unknown) {
    await pool.query('rollback').catch(() => undefined);
    throw error;
  }
}

describe('execution vocabulary populated prior-head upgrades', () => {
  it('rewrites 0005 rows through 0006 and 0007 as the real forced-RLS owner', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-vocabulary-prior-'),
    );
    const api = new Pool({
      connectionString: database.databaseUrl(apiBaseUrl),
      max: 1,
    });
    const verifier = new Pool({
      connectionString: database.databaseUrl(adminUrl),
      max: 1,
    });
    try {
      await copyMigrationsBefore(directory, '0006_');
      expect(await migrateDatabase(migrationConfig, directory)).toHaveLength(6);

      const workspaceOne = randomUUID();
      const workspaceTwo = randomUUID();
      const one = await seedWorkspaceVocabulary(api, workspaceOne, 1);
      const two = await seedWorkspaceVocabulary(api, workspaceTwo, 2);

      await copyFile(
        path.join(MIGRATIONS_DIRECTORY, '0006_execution_vocabulary.sql'),
        path.join(directory, '0006_execution_vocabulary.sql'),
      );
      await expect(
        migrateDatabase(migrationConfig, directory),
      ).resolves.toEqual(['0006_execution_vocabulary.sql']);

      const afterVocabulary = await verifier.query<{
        result_ref: unknown;
        run_status: string;
        record_status: string;
        trigger_type: string;
        updated_at: Date;
      }>(
        `select run.status run_status,run.trigger_type,run.updated_at,
                record.status record_status,record.result_ref
           from app.workflow_runs run
           join app.idempotency_records record
             on record.workspace_id=run.workspace_id
            and record.resource_id=run.id
          where run.id=any($1::uuid[])
          order by run.id,record.status`,
        [[one.canceledRunId, two.canceledRunId]],
      );
      expect(afterVocabulary.rows).toHaveLength(4);
      expect(
        afterVocabulary.rows.filter(
          (row) => row.record_status === 'in_progress',
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            result_ref: { marker: 'claimed-1' },
            run_status: 'canceled',
            trigger_type: 'manual',
          }),
          expect.objectContaining({
            result_ref: { marker: 'claimed-2' },
            run_status: 'canceled',
            trigger_type: 'manual',
          }),
        ]),
      );
      expect(
        afterVocabulary.rows.filter((row) => row.record_status === 'completed'),
      ).toHaveLength(2);
      expect(
        afterVocabulary.rows.every(
          (row) => row.updated_at > one.canceledCreatedAt,
        ),
      ).toBe(true);

      await copyFile(
        path.join(MIGRATIONS_DIRECTORY, '0007_execution_runtime.sql'),
        path.join(directory, '0007_execution_runtime.sql'),
      );
      await expect(
        migrateDatabase(migrationConfig, directory),
      ).resolves.toEqual(['0007_execution_runtime.sql']);

      const catalog = await verifier.query<{
        forced: boolean;
        owner: string;
        table_name: string;
      }>(`
        select class.relname table_name,class.relforcerowsecurity forced,
               pg_get_userbyid(class.relowner) owner
          from pg_class class
          join pg_namespace namespace on namespace.oid=class.relnamespace
         where namespace.nspname='app'
           and class.relname in ('workflow_runs','idempotency_records','run_events')
         order by class.relname
      `);
      expect(catalog.rows).toEqual([
        {
          forced: true,
          owner: 'pertexo_owner',
          table_name: 'idempotency_records',
        },
        { forced: true, owner: 'pertexo_owner', table_name: 'run_events' },
        { forced: true, owner: 'pertexo_owner', table_name: 'workflow_runs' },
      ]);
      const events = await verifier.query<{ count: string; type: string }>(
        `select type,count(*)::text count from app.run_events
          group by type order by type`,
      );
      expect(events.rows).toEqual([
        { count: '2', type: 'run.queued' },
        { count: '2', type: 'run.started' },
      ]);

      await api.query('begin');
      try {
        await api.query("select set_config('app.workspace_id',$1,true)", [
          workspaceOne,
        ]);
        const visible = await api.query<{ id: string }>(
          'select id from app.workflow_runs order by id',
        );
        expect(visible.rows.map((row) => row.id).sort()).toEqual(
          [one.canceledRunId, one.queuedRunId].sort(),
        );
        expect(visible.rows.map((row) => row.id)).not.toContain(
          two.canceledRunId,
        );
      } finally {
        await api.query('rollback');
      }

      const role = await verifier.query<{
        rolbypassrls: boolean;
        rolinherit: boolean;
      }>(
        "select rolbypassrls,rolinherit from pg_roles where rolname='pertexo_owner'",
      );
      expect(role.rows).toEqual([{ rolbypassrls: false, rolinherit: false }]);
    } finally {
      await Promise.allSettled([
        api.end(),
        verifier.end(),
        rm(directory, { recursive: true, force: true }),
      ]);
    }
  }, 60_000);
});
