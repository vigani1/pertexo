import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';
import { expect, it } from 'vitest';

import { migrateDatabase } from '../../../src/migrations.js';
import {
  seedWorkflow,
  withDatabase,
  withBaselineDatabase,
} from './upgrade-fixture.js';

const history = JSON.parse(
  await readFile(
    new URL('../../../migrations/pre-baseline-history.json', import.meta.url),
    'utf8',
  ),
) as { name: string; checksum: string }[];

it('adopts the full history without executing baseline SQL, retaining data and applying later migrations', async () => {
  await withBaselineDatabase(async ({ admin, config, directory }) => {
    await recordLegacyHistory(admin);
    const ids = await seedWorkflow(admin);
    await admin.query(
      "insert into app.auth_sessions(id,user_id,token,expires_at) values($1,$1,'retained-session',clock_timestamp()+interval '1 day')",
      [ids.ownerId],
    );
    await admin.query(
      'create sequence app.retained_sequence start 4400; alter sequence app.retained_sequence owner to pertexo_owner',
    );
    await admin.query("select nextval('app.retained_sequence')");
    const before = (await admin.query('select * from app.workflows')).rows;
    const database = (
      await admin.query<{ name: string }>('select current_database() name')
    ).rows[0]?.name;
    if (database === undefined) throw new Error('Database name missing');
    const catalog = (mode = '--schema-only') =>
      execFileSync(
        'docker',
        [
          'compose',
          'exec',
          '-T',
          'postgres',
          'pg_dump',
          '-U',
          'postgres',
          '-d',
          database,
          mode,
          '--exclude-table-data=pertexo_internal.schema_migrations',
          '--schema=app',
          '--schema=pertexo_internal',
        ],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      )
        .split('\n')
        .filter(
          (line) =>
            !line.startsWith('\\restrict ') &&
            !line.startsWith('\\unrestrict '),
        )
        .join('\n');
    const catalogBefore = catalog();
    const dataBefore = catalog('--data-only');
    for (const row of history)
      await rm(join(directory, row.name), { force: true });
    await writeFile(join(directory, '0000_baseline.sql'), 'select 1/0;');
    await expect(migrateDatabase(config, directory)).resolves.toEqual([]);
    expect(catalog()).toEqual(catalogBefore);
    expect(catalog('--data-only')).toEqual(dataBefore);
    await writeFile(
      join(directory, '0001_after_baseline.sql'),
      'create table app.after_baseline(id integer);',
    );
    await expect(migrateDatabase(config, directory)).resolves.toEqual([
      '0001_after_baseline.sql',
    ]);
    expect((await admin.query('select * from app.workflows')).rows).toEqual(
      before,
    );
    expect(before).toEqual([expect.objectContaining({ id: ids.workflowId })]);
    expect(
      (
        await admin.query(
          'select name from pertexo_internal.schema_migrations order by name',
        )
      ).rows,
    ).toEqual([
      { name: '0000_baseline.sql' },
      { name: '0001_after_baseline.sql' },
    ]);
    await expect(migrateDatabase(config, directory)).resolves.toEqual([]);
  });
});

it.each(['partial', 'baseline-only', 'unknown', 'checksum'] as const)(
  'refuses %s history without changing its receipts or data',
  async (kind) => {
    await withDatabase(async ({ admin, config, directory }) => {
      await recordLegacyHistory(admin);
      await seedWorkflow(admin);
      if (kind === 'partial')
        await admin.query(
          "delete from pertexo_internal.schema_migrations where name like '0122_%'",
        );
      if (kind === 'baseline-only')
        await admin.query(
          "delete from pertexo_internal.schema_migrations where name <> '0000_baseline.sql'",
        );
      if (kind === 'unknown')
        await admin.query(
          "insert into pertexo_internal.schema_migrations(name,checksum) values('9999_unknown.sql','unknown')",
        );
      if (kind === 'checksum')
        await admin.query(
          "update pertexo_internal.schema_migrations set checksum='changed' where name like '0122_%'",
        );
      const receipts = (
        await admin.query(
          'select * from pertexo_internal.schema_migrations order by name',
        )
      ).rows;
      const data = (await admin.query('select * from app.workflows')).rows;
      for (const row of history)
        await rm(join(directory, row.name), { force: true });
      await writeFile(join(directory, '0000_baseline.sql'), 'select 1/0;');
      await expect(migrateDatabase(config, directory)).rejects.toThrow(
        {
          'baseline-only': 'upgrade to the last pre-baseline release',
          partial: 'upgrade to the last pre-baseline release',
          unknown: 'Unknown applied migration',
          checksum: 'Applied migration checksum changed',
        }[kind],
      );
      if (kind === 'baseline-only' || kind === 'partial') {
        const cli = spawnSync(
          process.execPath,
          [fileURLToPath(new URL('../../../dist/migrate.js', import.meta.url))],
          {
            env: {
              ...process.env,
              DATABASE_MIGRATION_URL: config.connectionString,
            },
            encoding: 'utf8',
          },
        );
        expect(cli.status).toBe(1);
        expect(cli.stderr).toContain(
          'upgrade to the last pre-baseline release v0.2.0 first',
        );
      }
      expect(
        (
          await admin.query(
            'select * from pertexo_internal.schema_migrations order by name',
          )
        ).rows,
      ).toEqual(receipts);
      expect((await admin.query('select * from app.workflows')).rows).toEqual(
        data,
      );
    });
  },
);

it('applies the baseline to an empty database', async () => {
  await withDatabase(
    async ({ admin, config, directory }) => {
      await writeFile(
        join(directory, '0000_baseline.sql'),
        'create table public.baseline_values(value integer); insert into public.baseline_values values(42);',
      );
      await expect(migrateDatabase(config, directory)).resolves.toEqual([
        '0000_baseline.sql',
      ]);
      expect(
        (await admin.query('select * from public.baseline_values')).rows,
      ).toEqual([{ value: 42 }]);
      await expect(migrateDatabase(config, directory)).resolves.toEqual([]);
    },
    { migrate: false },
  );
});

async function recordLegacyHistory(admin: Pool) {
  await admin.query('delete from pertexo_internal.schema_migrations');
  await admin.query(
    'insert into pertexo_internal.schema_migrations(name,checksum) select name,checksum from jsonb_to_recordset($1::jsonb) as history(name text,checksum text)',
    [JSON.stringify(history)],
  );
}
