import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { migrateDatabase } from '../../../src/migrations.js';
import { withBaselineDatabase } from './upgrade-fixture.js';

it('serializes adoption and retains all old receipts when the first runner is terminated before its replacement receipt', async () => {
  await withBaselineDatabase(async ({ admin, config, directory }) => {
    const history: unknown = JSON.parse(
      await readFile(
        new URL(
          '../../../migrations/pre-baseline-history.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await admin.query('delete from pertexo_internal.schema_migrations');
    await admin.query(
      'insert into pertexo_internal.schema_migrations(name,checksum) select name,checksum from jsonb_to_recordset($1::jsonb) as history(name text,checksum text)',
      [JSON.stringify(history)],
    );
    const receipts = async () =>
      (
        await admin.query<{ name: string; checksum: string; applied_at: Date }>(
          'select * from pertexo_internal.schema_migrations order by name',
        )
      ).rows;
    const before = await receipts();
    // Pause at the replacement receipt, after deletion, without production hooks.
    await admin.query(`create function public.pause_adoption() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(4400); return new; end $$;
      create trigger pause_adoption before insert on pertexo_internal.schema_migrations
      for each row execute function public.pause_adoption()`);
    const holder = await admin.connect();
    const runs: Promise<unknown>[] = [];
    try {
      await holder.query('select pg_advisory_lock(4400)');
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('../../../dist/migrate.js', import.meta.url))],
        {
          env: {
            ...process.env,
            DATABASE_MIGRATION_URL: config.connectionString,
          },
          stdio: 'ignore',
        },
      );
      const first = once(child, 'exit');
      runs.push(first);
      let firstPid: number | undefined;
      await expect
        .poll(async () => {
          firstPid = (
            await admin.query<{ pid: number }>(
              "select pid from pg_locks where locktype='advisory' and objid=4400 and not granted and database=(select oid from pg_database where datname=current_database())",
            )
          ).rows[0]?.pid;
          return firstPid;
        })
        .toBeDefined();
      const second = migrateDatabase(config, directory).catch(
        (error: unknown) => error,
      );
      runs.push(second);
      await expect
        .poll(
          async () =>
            (
              await admin.query<{ count: number }>(
                "select count(*)::int count from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())",
              )
            ).rows[0]?.count,
        )
        .toBe(2);
      expect(
        (
          await admin.query<{ count: number }>(
            "select count(*)::int count from pg_locks where locktype='advisory' and objid<>4400 and not granted and database=(select oid from pg_database where datname=current_database())",
          )
        ).rows[0]?.count,
      ).toBe(1);
      expect(await receipts()).toEqual(before);
      child.kill('SIGKILL');
      expect(await first).toEqual([null, 'SIGKILL']);
      // The waiting runner must reach adoption after the terminated transaction rolls back.
      await expect
        .poll(
          async () =>
            (
              await admin.query<{ count: number }>(
                "select count(*)::int count from pg_locks where locktype='advisory' and objid=4400 and not granted and database=(select oid from pg_database where datname=current_database())",
              )
            ).rows[0]?.count,
        )
        .toBe(1);
      expect(await receipts()).toEqual(before);
      await holder.query('select pg_advisory_unlock(4400)');
      expect(await second).toEqual([]);
      expect(await receipts()).toEqual([
        expect.objectContaining({ name: '0000_baseline.sql' }),
      ]);
      await expect(migrateDatabase(config, directory)).resolves.toEqual([]);
    } finally {
      await holder.query('select pg_advisory_unlock_all()');
      holder.release();
      await Promise.all(runs);
    }
  });
});
