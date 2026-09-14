import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../src/migrations.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const fixtures: ReturnType<typeof createDisposableDatabaseFixture>[] = [];
const temporaryDirectories = new Set<string>();

function databaseUrl(name: string): string {
  const url = new URL(migrationBaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDatabase() {
  const name = `pertexo_test_migration_modes_${randomUUID().replaceAll('-', '')}`;
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: [
      'pertexo_migration',
      'pertexo_api',
      'pertexo_worker',
      'pertexo_dispatcher',
      'pertexo_maintenance',
      'pertexo_lifecycle_command',
      'pertexo_operator',
    ],
    databaseName: name,
    ownerRole: 'pertexo_owner',
  });
  fixtures.push(fixture);
  await fixture.create();
  return {
    config: {
      apiRuntimeRole: 'pertexo_api',
      connectionString: databaseUrl(name),
      dispatcherRole: 'pertexo_dispatcher',
      lifecycleCommandRole: 'pertexo_lifecycle_command',
      maintenanceRole: 'pertexo_maintenance',
      operatorRole: 'pertexo_operator',
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    },
    name,
  } as const;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-modes-'));
  temporaryDirectories.add(directory);
  return directory;
}

async function writePlan(
  directory: string,
  transactionalThrough: string,
  migrations: Record<string, unknown>,
) {
  await writeFile(
    path.join(directory, 'migration-execution-plan.json'),
    JSON.stringify({ migrations, schemaVersion: 1, transactionalThrough }),
  );
}

afterAll(async () => {
  const outcomes = await Promise.allSettled([
    ...fixtures.map((fixture) => fixture.drop()),
    ...[...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  ]);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(failures, 'Migration-mode fixture cleanup failed');
});

describe('migration execution modes', () => {
  it('commits each transactional migration before a later failure', async () => {
    const { config } = await createDatabase();
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, '0001_first.sql'),
      'create table app_first(id integer primary key);',
    );
    await writeFile(
      path.join(directory, '0002_broken.sql'),
      'select missing_relation;',
    );
    await writePlan(directory, '0002_broken.sql', {});

    await expect(migrateDatabase(config, directory)).rejects.toThrow();
    const owner = new Pool({
      connectionString: config.connectionString,
      max: 1,
    });
    try {
      await owner.query('set role pertexo_owner');
      const applied = await owner.query<{ name: string }>(
        'select name from pertexo_internal.schema_migrations order by name',
      );
      expect(applied.rows).toEqual([{ name: '0001_first.sql' }]);
    } finally {
      await owner.end();
    }
  });

  it('restarts the same online migration after the index committed but history recording failed', async () => {
    const { config, name: databaseName } = await createDatabase();
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, '0001_table.sql'),
      'create table online_items(id integer primary key, value text);',
    );
    await writePlan(directory, '0001_table.sql', {});
    await expect(migrateDatabase(config, directory)).resolves.toEqual([
      '0001_table.sql',
    ]);
    await writeFile(
      path.join(directory, '0002_online_index.sql'),
      'create index concurrently if not exists online_items_value_idx on online_items(value);',
    );
    await writePlan(directory, '0001_table.sql', {
      '0002_online_index.sql': {
        maximumDatabaseBytes: 1_000_000_000,
        mode: 'online',
        restartSafe: true,
        rollbackCompatibleThrough: '0001_table.sql',
      },
    });

    const owner = new Pool({
      connectionString: config.connectionString,
      max: 1,
    });
    const blocker = await owner.connect();
    const cancellationAdmin = new Pool({ connectionString: adminUrl, max: 1 });
    const advisoryKey = 7_166_118_815;
    try {
      await blocker.query('set role pertexo_owner');
      await blocker.query(`
        create or replace function pertexo_internal.block_online_history_test()
        returns trigger language plpgsql as $$
        begin
          if new.name='0002_online_index.sql' then
            perform pg_advisory_lock(${String(advisoryKey)});
          end if;
          return new;
        end $$;
        create trigger block_online_history_test
          before insert on pertexo_internal.schema_migrations
          for each row execute function pertexo_internal.block_online_history_test()
      `);
      await blocker.query('select pg_advisory_lock($1)', [advisoryKey]);
      const pending = migrateDatabase(config, directory);
      let runnerPid: number | undefined;
      for (
        let attempt = 0;
        attempt < 250 && runnerPid === undefined;
        attempt += 1
      ) {
        const waiting = await cancellationAdmin.query<{ pid: number }>(
          `select pid from pg_stat_activity
            where datname=$1 and wait_event='advisory'
              and query like '%schema_migrations%'
            order by pid limit 1`,
          [databaseName],
        );
        runnerPid = waiting.rows[0]?.pid;
        if (runnerPid === undefined)
          await cancellationAdmin.query('select pg_sleep(0.02)');
      }
      expect(runnerPid).toBeDefined();
      await cancellationAdmin.query('select pg_cancel_backend($1)', [
        runnerPid,
      ]);
      await expect(pending).rejects.toThrow();
      await blocker.query('select pg_advisory_unlock($1)', [advisoryKey]);
      await blocker.query(`
        drop trigger block_online_history_test
          on pertexo_internal.schema_migrations;
        drop function pertexo_internal.block_online_history_test()
      `);

      const partial = await blocker.query<{
        applied: boolean;
        index_valid: boolean;
      }>(`
        select
          exists(select 1 from pertexo_internal.schema_migrations
            where name='0002_online_index.sql') applied,
          exists(select 1 from pg_index
            where indexrelid='online_items_value_idx'::regclass
              and indisvalid and indisready) index_valid
      `);
      expect(partial.rows[0]).toEqual({ applied: false, index_valid: true });
      await expect(migrateDatabase(config, directory)).resolves.toEqual([
        '0002_online_index.sql',
      ]);
      await expect(migrateDatabase(config, directory)).resolves.toEqual([]);
    } finally {
      await blocker
        .query('select pg_advisory_unlock($1)', [advisoryKey])
        .catch(() => undefined);
      blocker.release();
      await owner.end();
      await cancellationAdmin.end();
    }
  });

  it('durably resumes bounded data batches across runner invocations', async () => {
    const { config } = await createDatabase();
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, '0001_seed.sql'),
      `create table resumable_items(id integer primary key, migrated boolean not null default false);
       insert into resumable_items(id) select generate_series(1,5);`,
    );
    await writeFile(
      path.join(directory, '0002_backfill.sql'),
      `with candidate as (
         select id from resumable_items where not migrated order by id limit 1 for update skip locked
       ), changed as (
         update resumable_items item set migrated=true from candidate
         where item.id=candidate.id returning item.id
       )
       select count(*)::integer processed_count,
         not exists(select 1 from resumable_items where not migrated) completed
       from changed;`,
    );
    await writePlan(directory, '0001_seed.sql', {
      '0002_backfill.sql': {
        batchLimit: 2,
        maximumDatabaseBytes: 1_000_000_000,
        mode: 'resumable',
        restartSafe: true,
        rollbackCompatibleThrough: '0001_seed.sql',
      },
    });

    await expect(migrateDatabase(config, directory)).rejects.toThrow(
      'requires another bounded run',
    );
    await expect(migrateDatabase(config, directory)).rejects.toThrow(
      'requires another bounded run',
    );
    await expect(migrateDatabase(config, directory)).resolves.toEqual([
      '0002_backfill.sql',
    ]);
    const owner = new Pool({
      connectionString: config.connectionString,
      max: 1,
    });
    try {
      await owner.query('set role pertexo_owner');
      const state = await owner.query<{
        batches_completed: string;
        rows_processed: string;
        status: string;
      }>(
        `select batches_completed::text,rows_processed::text,status
         from pertexo_internal.migration_jobs where name='0002_backfill.sql'`,
      );
      expect(state.rows[0]).toEqual({
        batches_completed: '6',
        rows_processed: '5',
        status: 'completed',
      });
    } finally {
      await owner.end();
    }
  });
});
