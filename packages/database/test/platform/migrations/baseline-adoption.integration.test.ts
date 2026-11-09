import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { migrateDatabase } from '../../../src/migrations.js';
import { seedWorkflow, withUpgradeDatabase } from './upgrade-fixture.js';

const history = JSON.parse(
  await readFile(
    new URL('../../../migrations/pre-baseline-history.json', import.meta.url),
    'utf8',
  ),
) as { name: string; checksum: string }[];

it('adopts the full history without executing baseline SQL, retaining data and applying later migrations', async () => {
  await withUpgradeDatabase(122, async ({ admin, config, directory }) => {
    const ids = await seedWorkflow(admin);
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
    for (const row of history) await rm(join(directory, row.name));
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

it.each(['partial', 'unknown', 'checksum'] as const)(
  'refuses %s history without changing its receipts or data',
  async (kind) => {
    await withUpgradeDatabase(122, async ({ admin, config, directory }) => {
      await seedWorkflow(admin);
      if (kind === 'partial')
        await admin.query(
          "delete from pertexo_internal.schema_migrations where name like '0122_%'",
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
      for (const row of history) await rm(join(directory, row.name));
      await writeFile(join(directory, '0000_baseline.sql'), 'select 1/0;');
      await expect(migrateDatabase(config, directory)).rejects.toThrow(
        {
          partial: 'upgrade to the last pre-baseline release',
          unknown: 'Unknown applied migration',
          checksum: 'Applied migration checksum changed',
        }[kind],
      );
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
  await withUpgradeDatabase(-1, async ({ admin, config, directory }) => {
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
  });
});
