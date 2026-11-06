import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import {
  createDisposableDatabaseFixture,
  expectedMigrationsAfter,
  migrateDatabase,
  MIGRATIONS_DIRECTORY,
} from '@pertexo/database/testing';

it('backfills populated retained history and applies the journaled migration once', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL ?? '';
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_daily_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-daily-upgrade-'));
  let admin: Pool | undefined;
  try {
    await fixture.create();
    for (const name of await expectedMigrationsAfter(-1)) {
      if (Number(name.slice(0, 4)) <= 110)
        await copyFile(join(MIGRATIONS_DIRECTORY, name), join(directory, name));
    }
    const config = {
      connectionString: fixture.databaseUrl(
        process.env.DATABASE_MIGRATION_URL ?? '',
      ),
      ownerRole: 'pertexo_owner',
      appRole: 'pertexo_app',
      maintenanceRole: 'pertexo_maintenance',
    };
    await migrateDatabase(config, directory);
    admin = new Pool({ connectionString: fixture.databaseUrl(adminUrl) });
    const actor = randomUUID(),
      workspace = randomUUID(),
      workflow = randomUUID();
    await admin.query(
      `insert into app.users(id,email,display_name) values($1,$2,'Daily upgrade')`,
      [actor, `${actor}@example.test`],
    );
    await admin.query(
      `insert into app.workspaces(id,name,slug,created_by) values($1,'Daily upgrade',$2,$3)`,
      [workspace, `daily-${workspace}`, actor],
    );
    await admin.query(
      `insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Daily history',$3)`,
      [workflow, workspace, actor],
    );
    await admin.query(
      `with tenant as (select set_config('app.workspace_id',$1::uuid::text,true))
      insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,completed_at)
      select gen_random_uuid(),$1,$2,gen_random_uuid(),case when n=4 then 'test' else 'manual' end,
        case when n=3 then 'succeeded' else 'failed' end,
        case when n=5 then now()-interval '31 days' else now() end from generate_series(1,5)n cross join tenant`,
      [workspace, workflow],
    );
    expect(await migrateDatabase(config)).toEqual(
      await expectedMigrationsAfter(110),
    );
    const result = await admin.query(
      `select workflow_id,count::int from app.workspace_inbox_failure_days where workspace_id=$1`,
      [workspace],
    );
    expect(result.rows).toEqual([{ workflow_id: workflow, count: 2 }]);
    expect(await migrateDatabase(config)).toEqual([]);
  } finally {
    await admin?.end();
    await fixture.drop();
    await rm(directory, { recursive: true, force: true });
  }
});
