import { execFileSync } from 'node:child_process';
import { copyFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  migrateDatabase,
  MIGRATIONS_DIRECTORY,
} from '../../../src/migrations.js';
import { seedWorkflow, withBaselineDatabase } from './upgrade-fixture.js';

it('upgrades an adopted baseline through the real later migrations, preserving data and matching the release catalog', async () => {
  await withBaselineDatabase(async ({ admin, config, directory }) => {
    const ids = await seedWorkflow(admin);
    await admin.query(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) values($1,$2,$1,1,'{"nodes":[],"edges":[],"settings":{}}','{}','wf:sha256:'||repeat('a',64),$3)`,
      [ids.workflowId, ids.workspaceId, ids.ownerId],
    );
    const runClient = await admin.connect();
    try {
      await runClient.query('begin');
      await runClient.query("select set_config('app.workspace_id',$1,true)", [
        ids.workspaceId,
      ]);
      await runClient.query(
        `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values(gen_random_uuid(),$1,$2,$2,'manual','succeeded'),(gen_random_uuid(),$1,$2,$2,'test','failed')`,
        [ids.workspaceId, ids.workflowId],
      );
      await runClient.query('commit');
    } finally {
      runClient.release();
    }
    const versionsBefore = (
      await admin.query('select * from app.workflow_versions order by id')
    ).rows;
    const runsBefore = (
      await admin.query('select * from app.workflow_runs order by id')
    ).rows;
    const before = (await admin.query('select * from app.workflows')).rows;
    const history = JSON.parse(
      await readFile(
        new URL(
          '../../../migrations/pre-baseline-history.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as object[];
    await admin.query('delete from pertexo_internal.schema_migrations');
    await admin.query(
      'insert into pertexo_internal.schema_migrations(name,checksum) select name,checksum from jsonb_to_recordset($1::jsonb) as history(name text,checksum text)',
      [JSON.stringify(history)],
    );
    await expect(migrateDatabase(config, directory)).resolves.toEqual([]);
    expect(
      (await admin.query('select name from pertexo_internal.schema_migrations'))
        .rows,
    ).toEqual([{ name: '0000_baseline.sql' }]);
    // Every release migration after the baseline, so the catalog is the release's.
    const later = (await readdir(MIGRATIONS_DIRECTORY))
      .filter((name) => name.endsWith('.sql') && name !== '0000_baseline.sql')
      .sort();
    expect(later[0]).toBe('0001_ordinary_run_history.sql');
    for (const name of later)
      await copyFile(join(MIGRATIONS_DIRECTORY, name), join(directory, name));
    await expect(migrateDatabase(config, directory)).resolves.toEqual(later);
    expect((await admin.query('select * from app.workflows')).rows).toEqual(
      before,
    );
    expect(
      (await admin.query('select * from app.workflow_runs order by id')).rows,
    ).toEqual(runsBefore);
    expect(
      (await admin.query('select * from app.workflow_versions order by id'))
        .rows,
    ).toEqual(versionsBefore);
    expect(before).toEqual([expect.objectContaining({ id: ids.workflowId })]);
    await expect(migrateDatabase(config, directory)).resolves.toEqual([]);
    const database = new URL(config.connectionString).pathname.slice(1);
    const catalog = execFileSync(
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
        '--schema-only',
        '--schema=app',
        '--schema=pertexo_internal',
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    )
      .split('\n')
      .filter(
        (line) =>
          !line.startsWith('-- Dumped ') &&
          !line.startsWith('\\restrict ') &&
          !line.startsWith('\\unrestrict '),
      )
      .join('\n');
    expect(catalog).toBe(
      await readFile(new URL('../../../schema.sql', import.meta.url), 'utf8'),
    );
  });
}, 60_000);
