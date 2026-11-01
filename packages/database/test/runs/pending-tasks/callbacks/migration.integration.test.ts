import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import {
  migrateDatabase,
  MIGRATIONS_DIRECTORY,
} from '../../../../src/migrations.js';
import { createDisposableDatabaseFixture } from '../../../../src/testing/postgres/disposable-database.js';

it('upgrades populated human tasks without changing their decisions or context', async () => {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const migrationUrl =
    process.env.DATABASE_MIGRATION_URL ??
    'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
  const database = createDisposableDatabaseFixture({
    adminUrl,
    databaseName: `pertexo_test_callback_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
    connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  });
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-before-callbacks-'));
  const owner = new Pool({
    connectionString: database.databaseUrl(adminUrl),
    max: 1,
  });
  let created = false;
  try {
    await database.create();
    created = true;
    for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
      if (/^\d{4}_.*\.sql$/u.test(name) && name < '0048_')
        await copyFile(join(MIGRATIONS_DIRECTORY, name), join(directory, name));
    }
    const config = {
      connectionString: database.databaseUrl(migrationUrl),
      ownerRole: 'pertexo_owner',
      appRole: 'pertexo_app',
      maintenanceRole: 'pertexo_maintenance',
    };
    await migrateDatabase(config, directory);
    const user = randomUUID(),
      workspace = randomUUID(),
      workflow = randomUUID(),
      version = randomUUID(),
      run = randomUUID();
    await owner.query("select set_config('app.workspace_id',$1,false)", [
      workspace,
    ]);
    await owner.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Callback upgrade')",
      [user, `${user}@example.test`],
    );
    await owner.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Upgrade',$3,$2)",
      [workspace, user, `upgrade-${workspace}`],
    );
    await owner.query(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Upgrade',$3)",
      [workflow, workspace, user],
    );
    await owner.query(
      "insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) values($1,$2,$3,1,'{}','{}','wf:sha256:'||repeat('a',64),$4)",
      [version, workspace, workflow, user],
    );
    await owner.query(
      "insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,started_at) values($1,$2,$3,$4,'manual','waiting',clock_timestamp())",
      [run, workspace, workflow, version],
    );
    for (const [kind, status] of [
      ['approval', 'pending'],
      ['input_request', 'submitted'],
    ] as const) {
      const node = randomUUID(),
        task = randomUUID();
      await owner.query(
        "insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,status,side_effect_class,control_kind,resume_at) values($1,$2,$3,$4,$4,'waiting','safe','human_task',clock_timestamp()+interval '7 days')",
        [node, workspace, run, kind],
      );
      await owner.query(
        `insert into app.pending_run_tasks(id,workspace_id,run_id,workflow_version_id,node_run_id,invocation_key,kind,config,status,context,expires_at,output_ref,decided_by,completed_at)
        values($1,$2,$3,$4,$5,$6,$6,'{}',$7::varchar,'{"details":{"Order":17}}',clock_timestamp()+interval '7 days',case when $7::varchar='submitted' then '{"kind":"inline","value":{"answer":"retained"}}'::json else null end,case when $7::varchar='submitted' then $8::uuid else null end,case when $7::varchar='submitted' then clock_timestamp() else null end)`,
        [task, workspace, run, version, node, kind, status, user],
      );
    }
    const before = (
      await owner.query<Record<string, unknown>>(
        'select * from app.pending_run_tasks order by id',
      )
    ).rows;
    expect(await migrateDatabase(config)).toEqual([
      '0048_callback_waits.sql',
      '0049_live_callback_keys.sql',
      '0050_folder_access.sql',
      '0051_connection_sharing.sql',
      '0052_publication_reuse_candidates.sql',
      '0053_remove_artifact_lookup.sql',
      '0054_form_uploads.sql',
      '0055_task_timeout_output.sql',
      '0056_unsent_public_form_uploads.sql',
      '0057_users_canonical_email_index.sql',
      '0058_workspace_reactivation.sql',
      '0059_suspended_inbox.sql',
      '0060_write_probe.sql',
      '0061_sign_up_invitations.sql',
      '0062_endpoints_follow_the_step.sql',
      '0063_webhook_repeats_need_a_key.sql',
      '0064_instance_capacity.sql',
      '0065_run_delivery_deadline.sql',
      '0066_outbox_redeliveries.sql',
      '0067_oauth2_connections.sql',
    ]);
    const after = (
      await owner.query<Record<string, unknown>>(
        'select * from app.pending_run_tasks order by id',
      )
    ).rows;
    expect(after).toHaveLength(2);
    for (const [index, row] of before.entries())
      expect(after[index]).toMatchObject({
        ...row,
        callback_token_hash: null,
        callback_key_version: null,
        opened_at: null,
      });
    expect(
      (
        await owner.query(
          "select relforcerowsecurity from pg_class where oid='app.pending_run_tasks'::regclass",
        )
      ).rows,
    ).toEqual([{ relforcerowsecurity: true }]);
  } finally {
    await owner.end();
    if (created) await database.drop();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
