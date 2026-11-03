import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { createDisposableDatabaseFixture, migrateDatabase, MIGRATIONS_DIRECTORY, parseDatabaseConfig } from '@pertexo/database/testing';
import { createWorkflowTriggerPauseFoldStore } from '../../../src/triggers/pause/fold.store.js';

it('continues a populated 0084 streak after upgrade and clears only its opaque carry when an older success arrives', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL ?? 'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const fixture = createDisposableDatabaseFixture({ adminUrl, databaseName: `pertexo_test_pause_upgrade_${randomUUID().replaceAll('-', '')}`,
    connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'], ownerRole: 'pertexo_owner' });
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-pause-upgrade-'));
  const config = { appRole: 'pertexo_app', ownerRole: 'pertexo_owner', maintenanceRole: 'pertexo_maintenance',
    connectionString: fixture.databaseUrl(process.env.DATABASE_MIGRATION_URL ?? 'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo') };
  const admin = new Pool({ connectionString: fixture.databaseUrl(adminUrl), max: 2 });
  let fold: ReturnType<typeof createWorkflowTriggerPauseFoldStore> | undefined;
  try {
    await fixture.create();
    for (const name of await readdir(MIGRATIONS_DIRECTORY))
      if (/^\d{4}_.*\.sql$/u.test(name) && Number(name.slice(0, 4)) <= 84) await copyFile(join(MIGRATIONS_DIRECTORY, name), join(directory, name));
    await migrateDatabase(config, directory);
    const owner = randomUUID(), workspace = randomUUID(), workflow = randomUUID(), paused = randomUUID(), zero = randomUUID();
    await admin.query("insert into app.users(id,email,display_name) values($1,$2,'Upgrade owner')", [owner, `${owner}@example.test`]);
    await admin.query("insert into app.workspaces(id,name,slug,created_by) values($1::uuid,'Existing install',$1::text,$2)", [workspace, owner]);
    for (const id of [workflow, paused, zero]) await admin.query("insert into app.workflows(id,workspace_id,name,created_by,auto_pause_enabled) values($1::uuid,$2,$1::text,$3,false)", [id, workspace, owner]);
    await admin.query(`insert into app.workflow_failure_streaks(workspace_id,workflow_id,consecutive_failures,last_run_id,last_ended_at,resumed_after)
      values($1,$2,7,$3,'2026-10-01T01:00:00.123456Z','2026-09-30T00:00:00.123456Z'),($1,$4,0,null,null,null)`, [workspace, workflow, randomUUID(), zero]);
    await admin.query(`update app.workflows set trigger_pause_state='paused',trigger_paused_at='2026-10-01',trigger_pause_reason='consecutive_failures',trigger_pause_failures=8,trigger_pause_revision=5,trigger_pause_last_run_id=$2 where id=$1`, [paused, randomUUID()]);
    const pauseBefore = (await admin.query<Record<string, unknown>>('select to_jsonb(w) row from app.workflows w where id=$1', [paused])).rows;
    const enqueue = async (failure: boolean, endedAt: string) => {
      const runId = randomUUID();
      await admin.query(`with tenant as (select set_config('app.workspace_id',$2::text,true)) insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
        select $1::uuid,$2::uuid,$3::uuid,$4::uuid,'schedule',$5 from tenant`, [runId, workspace, workflow, randomUUID(), failure ? 'failed' : 'succeeded']);
      await admin.query('insert into app.workflow_trigger_outcomes(id,workspace_id,workflow_id,run_id,counts_as_failure,ended_at) values($1,$2,$3,$4,$5,$6)', [randomUUID(), workspace, workflow, runId, failure, endedAt]);
      return runId;
    };
    const later = await enqueue(true, '2026-10-01T03:00:00.123456Z');
    await migrateDatabase(config);
    expect((await admin.query('select to_jsonb(w) row from app.workflows w where id=$1', [paused])).rows).toEqual(pauseBefore);
    expect((await admin.query('select consecutive_failures,legacy_failures,success_ended_at,success_outcome_id from app.workflow_failure_streaks where workflow_id=$1', [zero])).rows).toEqual([{ consecutive_failures: 0, legacy_failures: 0, success_ended_at: null, success_outcome_id: null }]);
    fold = createWorkflowTriggerPauseFoldStore(parseDatabaseConfig({ connectionString: fixture.databaseUrl(process.env.DATABASE_MAINTENANCE_URL ?? 'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo'), max: 2 }));
    await fold.foldPending(1);
    expect((await admin.query('select consecutive_failures from app.workflow_failure_streaks where workflow_id=$1', [workflow])).rows).toEqual([{ consecutive_failures: 8 }]);
    await enqueue(false, '2026-10-01T02:00:00.123456Z');
    await fold.foldPending(1);
    expect((await admin.query('select consecutive_failures,legacy_failures,last_run_id from app.workflow_failure_streaks where workflow_id=$1', [workflow])).rows).toEqual([{ consecutive_failures: 1, legacy_failures: 0, last_run_id: later }]);
  } finally { await fold?.close(); await admin.end(); await fixture.drop(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
