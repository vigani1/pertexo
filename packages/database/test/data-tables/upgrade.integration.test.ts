import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../../src/migrations.js';
import { createDisposableDatabaseFixture } from '../../src/testing/postgres/disposable-database.js';

it('backfills stable IDs without changing populated rows or published graphs and retains forced RLS', async () => {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_table_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-table-upgrade-'));
  let admin: Pool | undefined;
  try {
    await fixture.create();
    for (const name of await readdir(MIGRATIONS_DIRECTORY))
      if (name.endsWith('.sql') && Number(name.slice(0, 4)) < 29)
        await copyFile(join(MIGRATIONS_DIRECTORY, name), join(directory, name));
    const config = {
      appRole: 'pertexo_app',
      ownerRole: 'pertexo_owner',
      maintenanceRole: 'pertexo_maintenance',
      connectionString: fixture.databaseUrl(
        process.env.DATABASE_MIGRATION_URL ??
          'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
      ),
    };
    await migrateDatabase(config, directory);
    admin = new Pool({
      connectionString: fixture.databaseUrl(adminUrl),
      max: 1,
    });
    const user = randomUUID(),
      workspace = randomUUID(),
      table = randomUUID(),
      row = randomUUID(),
      workflow = randomUUID(),
      version = randomUUID();
    const columns = [
      { name: 'key', type: 'text', required: true },
      { name: 'amount', type: 'number', required: true },
    ];
    const values = '{"amount":2,"key":"a"}';
    const graph = {
      nodes: [
        {
          id: 'find',
          definition: { key: 'core.table_find', version: 1 },
          config: { table: 'Orders' },
        },
      ],
      edges: [],
      settings: {},
    };
    await admin.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Table owner')",
      [user, `${user}@example.test`],
    );
    await admin.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Table upgrade',$2,$3)",
      [workspace, `tables-${workspace}`, user],
    );
    await admin.query(
      "insert into app.workspace_data_tables(id,workspace_id,name,columns_json,key_column,row_count,stored_bytes) values($1,$2,'Orders',$3::jsonb,'key',1,$4)",
      [table, workspace, JSON.stringify(columns), Buffer.byteLength(values)],
    );
    await admin.query(
      'insert into app.workspace_data_table_rows(workspace_id,table_id,id,values_json,key_value) values($1,$2,$3,$4,$5)',
      [workspace, table, row, values, '"a"'],
    );
    await admin.query(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Table workflow',$3)",
      [workflow, workspace, user],
    );
    await admin.query(
      'insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) values($1,$2,$3,1,$4::jsonb,$5::jsonb,$6,$7)',
      [
        version,
        workspace,
        workflow,
        JSON.stringify(graph),
        JSON.stringify({ graph }),
        `wf:sha256:${'a'.repeat(64)}`,
        user,
      ],
    );
    await migrateDatabase(config);
    const upgraded = (
      await admin.query(
        'select columns_json,has_removed_columns,stored_bytes,row_count,revision from app.workspace_data_tables where id=$1',
        [table],
      )
    ).rows;
    expect(upgraded).toEqual([
      {
        columns_json: columns.map((column) => ({ ...column, id: column.name })),
        has_removed_columns: false,
        stored_bytes: Buffer.byteLength(values),
        row_count: 1,
        revision: 1,
      },
    ]);
    expect(
      (
        await admin.query(
          'select values_json,key_value,revision from app.workspace_data_table_rows where id=$1',
          [row],
        )
      ).rows,
    ).toEqual([{ values_json: values, key_value: '"a"', revision: 1 }]);
    expect(
      (
        await admin.query(
          'select graph_json,executable_json,checksum from app.workflow_versions where id=$1',
          [version],
        )
      ).rows,
    ).toEqual([
      {
        graph_json: graph,
        executable_json: { graph },
        checksum: `wf:sha256:${'a'.repeat(64)}`,
      },
    ]);
    expect(
      (
        await admin.query(
          "select relrowsecurity,relforcerowsecurity from pg_class where oid='app.workspace_data_tables'::regclass",
        )
      ).rows,
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  } finally {
    await admin?.end();
    await fixture.drop();
    await rm(directory, { recursive: true, force: true });
  }
});
