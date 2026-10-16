import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../../src/migrations.js';
import { createDisposableDatabaseFixture } from '../support/postgres/disposable-database.js';

async function legacyDatabase(
  work: (context: {
    admin: Pool;
    upgrade: () => Promise<readonly string[]>;
    workspaceId: string;
    workflowId: string;
    owner: string;
  }) => Promise<void>,
) {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_vars_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-vars-upgrade-'));
  let admin: Pool | undefined;
  try {
    await fixture.create();
    for (const name of await readdir(MIGRATIONS_DIRECTORY))
      if (/^00(?:0[0-9]|1[0-5])_.*\.sql$/u.test(name))
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
    const owner = randomUUID(),
      workspaceId = randomUUID(),
      workflowId = randomUUID();
    await admin.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Upgrade owner')",
      [owner, `${owner}@example.test`],
    );
    await admin.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Variables upgrade',$2,$3)",
      [workspaceId, `vars-${workspaceId}`, owner],
    );
    await admin.query(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Preserved workflow',$3)",
      [workflowId, workspaceId, owner],
    );
    await admin.query(
      'insert into app.workspace_variables(workspace_id,revision,values_json) values($1,2,\'{"RATE":20}\')',
      [workspaceId],
    );
    await admin.query("select set_config('app.workspace_id',$1,false)", [
      workspaceId,
    ]);
    await work({
      admin,
      upgrade: () => migrateDatabase(config),
      workspaceId,
      workflowId,
      owner,
    });
  } finally {
    await admin?.end();
    await fixture.drop();
    await rm(directory, { recursive: true, force: true });
  }
}

it('backfills current and retained historical sets, fixed empty sets and purged runs without copies', async () => {
  await legacyDatabase(
    async ({ admin, upgrade, workspaceId, workflowId, owner }) => {
      const retained = randomUUID(),
        empty = randomUUID(),
        purged = randomUUID(),
        preview = randomUUID();
      for (const [id, snapshot] of [
        [retained, { revision: 1, values: { RATE: 10 } }],
        [empty, { revision: 0, values: {} }],
        [purged, null],
      ] as const) {
        await admin.query(
          `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,variable_snapshot,details_purged_at) values($1,$2,$3,$4,'manual','failed',$5::jsonb,case when $5::jsonb is null then clock_timestamp() end)`,
          [
            id,
            workspaceId,
            workflowId,
            randomUUID(),
            snapshot === null ? null : JSON.stringify(snapshot),
          ],
        );
      }
      await admin.query(
        `insert into app.preview_runs(id,workspace_id,workflow_id,draft_revision,draft_fingerprint,node_id,definition_key,definition_version,executor_key,executor_version,actor_user_id,idempotency_key_hash,request_hash,executable_node_json,input_ref,side_effect_class,may_contact_provider,may_cause_external_side_effect,dry_run,execution_deadline_at,expires_at,variable_snapshot) values($1,$2,$3,1,$4,'step','core.set',1,'core.set',1,$5,$4,$4,'{}','{"kind":"inline","value":null}','safe',false,false,'not_supported',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 days','{"revision":1,"values":{"RATE":10}}')`,
        [preview, workspaceId, workflowId, 'a'.repeat(64), owner],
      );
      expect(await upgrade()).toEqual([
        '0016_variable_set_revisions.sql',
        '0017_system_mail_deliveries.sql',
        '0018_workflow_polish.sql',
        '0019_pinned_step_samples.sql',
        '0020_webhook_responses.sql',
      ]);
      expect(
        (
          await admin.query(
            'select revision,values_json,descriptions_json from app.workspace_variable_set_revisions where workspace_id=$1 order by revision',
            [workspaceId],
          )
        ).rows,
      ).toEqual([
        { revision: 1, values_json: { RATE: 10 }, descriptions_json: {} },
        { revision: 2, values_json: { RATE: 20 }, descriptions_json: {} },
      ]);
      expect(
        (
          await admin.query(
            'select variable_set_revision from app.workflow_runs where id=$1',
            [retained],
          )
        ).rows,
      ).toEqual([{ variable_set_revision: 1 }]);
      expect(
        (
          await admin.query(
            'select variable_set_revision,details_purged_at is not null purged from app.workflow_runs where id=any($1::uuid[]) order by details_purged_at nulls first',
            [[empty, purged]],
          )
        ).rows,
      ).toEqual([
        { variable_set_revision: null, purged: false },
        { variable_set_revision: null, purged: true },
      ]);
      expect(
        (
          await admin.query(
            'select variable_set_revision from app.preview_runs where id=$1',
            [preview],
          )
        ).rows,
      ).toEqual([{ variable_set_revision: 1 }]);
      expect(
        (
          await admin.query(
            "select column_name from information_schema.columns where table_schema='app' and ((table_name in ('workflow_runs','preview_runs') and column_name='variable_snapshot') or (table_name='workspace_variables' and column_name='values_json'))",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await admin.query(
            "select has_table_privilege('pertexo_app','app.workspace_variable_set_revisions','SELECT') readable, has_table_privilege('pertexo_app','app.workspace_variable_set_revisions','UPDATE') mutable",
          )
        ).rows,
      ).toEqual([{ readable: true, mutable: false }]);
      expect(
        (
          await admin.query(
            "select relforcerowsecurity forced from pg_class where oid='app.preview_runs'::regclass",
          )
        ).rows,
      ).toEqual([{ forced: true }]);
      expect(await upgrade()).toEqual([]);
    },
  );
});
it.each([
  [
    { revision: 2, values: { RATE: 99 } },
    'Stored workspace variable snapshots disagree for the same workspace revision',
  ],
  [
    { revision: 0, values: { RATE: 99 } },
    'Stored workspace variable snapshots do not have a valid revision and value map',
  ],
])(
  'refuses an inconsistent legacy capture atomically: %j',
  async (snapshot, message) => {
    await legacyDatabase(
      async ({ admin, upgrade, workspaceId, workflowId }) => {
        await admin.query(
          "insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,variable_snapshot) values($1,$2,$3,$4,'manual','failed',$5::jsonb)",
          [
            randomUUID(),
            workspaceId,
            workflowId,
            randomUUID(),
            JSON.stringify(snapshot),
          ],
        );
        await expect(upgrade()).rejects.toThrow(message);
        expect(
          (
            await admin.query(
              "select to_regclass('app.workspace_variable_set_revisions') relation",
            )
          ).rows,
        ).toEqual([{ relation: null }]);
        expect(
          (
            await admin.query(
              'select revision,values_json from app.workspace_variables where workspace_id=$1',
              [workspaceId],
            )
          ).rows,
        ).toEqual([{ revision: 2, values_json: { RATE: 20 } }]);
      },
    );
  },
);
