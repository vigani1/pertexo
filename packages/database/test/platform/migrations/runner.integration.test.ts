import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { migrateDatabase } from '../../../src/migrations.js';
import { withDatabase } from './upgrade-fixture.js';

it('times out on a held migration lock, then migrates after its release', async () => {
  await withDatabase(
    async ({ admin, config, directory }) => {
      const holder = await admin.connect();
      // The stable application migration-lock namespace is an interoperability contract.
      const lockId = 7_166_118_812;
      try {
        await holder.query('select pg_advisory_lock($1)', [lockId]);
        const started = performance.now();
        const result = migrateDatabase(config, directory, {
          lockTimeoutMs: 1_000,
          statementTimeoutMs: 5_000,
        }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await expect
          .poll(
            async () =>
              (
                await admin.query<{ count: number }>(
                  "select count(*)::int count from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())",
                )
              ).rows[0]?.count,
          )
          .toBe(1);
        expect(await result).toMatchObject({ error: { code: '55P03' } });
        expect(performance.now() - started).toBeLessThan(5_000);
        await holder.query('select pg_advisory_unlock($1)', [lockId]);
        await expect(migrateDatabase(config, directory)).resolves.toEqual([]);
      } finally {
        await holder.query('select pg_advisory_unlock_all()');
        holder.release();
      }
    },
    { migrate: false },
  );
});

it('rolls back a migration that writes before failing and applies its correction exactly once', async () => {
  await withDatabase(
    async ({ admin, config, directory }) => {
      await admin.query('create table public.retained_values(value text)');
      await admin.query("insert into public.retained_values values('before')");
      await admin.query(
        'grant select,insert on public.retained_values to pertexo_owner',
      );
      const name = '0000_atomic_write.sql';
      const sql = `create table public.new_values(value text);
      insert into public.new_values values('new');
      insert into public.retained_values values('after');`;
      await writeFile(join(directory, name), `${sql}\n select 1/0;`);
      await expect(migrateDatabase(config, directory)).rejects.toMatchObject({
        file: name,
        cause: { code: '22012' },
      });
      expect(
        (await admin.query("select to_regclass('public.new_values') relation"))
          .rows,
      ).toEqual([{ relation: null }]);
      expect(
        (await admin.query('select * from public.retained_values')).rows,
      ).toEqual([{ value: 'before' }]);
      expect(
        (await admin.query('select * from pertexo_internal.schema_migrations'))
          .rows,
      ).toEqual([]);

      // A receipt failure happens after the SQL has succeeded, so it also tests the
      // transaction spanning the migration and its receipt, beyond pg's statement atomicity.
      await admin.query(`create function public.refuse_receipt() returns trigger language plpgsql as $$
      begin raise exception 'receipt unavailable'; end $$;
      create trigger refuse_receipt before insert on pertexo_internal.schema_migrations
      for each row execute function public.refuse_receipt()`);
      await writeFile(join(directory, name), sql);
      await expect(migrateDatabase(config, directory)).rejects.toThrow(
        'receipt unavailable',
      );
      expect(
        (await admin.query("select to_regclass('public.new_values') relation"))
          .rows,
      ).toEqual([{ relation: null }]);
      expect(
        (await admin.query('select * from public.retained_values')).rows,
      ).toEqual([{ value: 'before' }]);
      expect(
        (await admin.query('select * from pertexo_internal.schema_migrations'))
          .rows,
      ).toEqual([]);
      await admin.query(
        'drop trigger refuse_receipt on pertexo_internal.schema_migrations',
      );

      await expect(migrateDatabase(config, directory)).resolves.toEqual([name]);
      const receipts = (
        await admin.query('select * from pertexo_internal.schema_migrations')
      ).rows;
      await expect(migrateDatabase(config, directory)).resolves.toEqual([]);
      expect(
        (await admin.query('select * from pertexo_internal.schema_migrations'))
          .rows,
      ).toEqual(receipts);
      expect(receipts).toHaveLength(1);
      expect(
        (await admin.query('select * from public.new_values')).rows,
      ).toEqual([{ value: 'new' }]);
      expect(
        (
          await admin.query(
            'select * from public.retained_values order by value',
          )
        ).rows,
      ).toEqual([{ value: 'after' }, { value: 'before' }]);
    },
    { migrate: false },
  );
});
