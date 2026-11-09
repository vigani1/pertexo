import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  createDisposableDatabaseFixture,
  migrateDatabase,
} from '@pertexo/database/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { maintenanceConfig } from '../../../../infrastructure/testing/worker-databases.mjs';
import { createWorkspaceInboxFoldStore } from '../../src/inbox/folding/workspace-inbox-fold.store.js';

it('upgrades pending events and private revisions, then folds them once through the scoped worker', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL ?? '';
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_fold_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });

  let admin: Pool | undefined;
  let fold: ReturnType<typeof createWorkspaceInboxFoldStore> | undefined;
  try {
    await fixture.create();

    const config = {
      connectionString: fixture.databaseUrl(
        process.env.DATABASE_MIGRATION_URL ?? '',
      ),
      ownerRole: 'pertexo_owner',
      appRole: 'pertexo_app',
      maintenanceRole: 'pertexo_maintenance',
    };
    await migrateDatabase(config);
    admin = new Pool({ connectionString: fixture.databaseUrl(adminUrl) });
    const actor = randomUUID(),
      workspace = randomUUID(),
      workflow = randomUUID(),
      run = randomUUID(),
      thread = randomUUID();
    await admin.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Fold upgrade')",
      [actor, `${actor}@example.test`],
    );
    await admin.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Fold upgrade',$2,$3)",
      [workspace, `fold-${workspace}`, actor],
    );
    await admin.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')",
      [workspace, actor],
    );
    await admin.query(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Fold history',$3)",
      [workflow, workspace, actor],
    );
    await admin.query(
      `with tenant as (select set_config('app.workspace_id',$1::uuid::text,true))
      insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
      select $2,$1,$3,gen_random_uuid(),'manual','timed_out' from tenant`,
      [workspace, run, workflow],
    );
    const previous = (
      await admin.query<{ revision: string }>(
        `insert into app.workspace_inbox_threads(workspace_id,id,notice_kind,subject_id,workflow_id,revision,occurrence_count,first_occurred_at,latest_occurred_at,latest_run_id,latest_kind)
      values($1,$2,'workflow_failure',$3,$3,nextval('app.workspace_inbox_revision_seq'),5,now()-interval '2 hours',now()-interval '1 hour',$4,'failed') returning revision::text`,
        [workspace, thread, workflow, run],
      )
    ).rows[0];
    if (previous === undefined) throw new Error('Missing upgrade thread');
    await admin.query(
      'insert into app.workspace_inbox_reads(workspace_id,user_id,thread_id,read_revision) values($1,$2,$3,$4)',
      [workspace, actor, thread, previous.revision],
    );
    await admin.query(
      "insert into app.workspace_inbox_events(id,workspace_id,workflow_id,run_id,terminal_event_sequence,kind,occurred_at) values($1,$2,$3,$4,7,'timed_out',now())",
      [randomUUID(), workspace, workflow, run],
    );
    const before = (
      await admin.query(
        'select to_jsonb(e) value from app.workspace_inbox_events e',
      )
    ).rows;

    expect(
      (
        await admin.query(
          'select to_jsonb(e) value from app.workspace_inbox_events e',
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await admin.query(
          'select thread_id,read_revision::text from app.workspace_inbox_reads',
        )
      ).rows,
    ).toEqual([{ thread_id: thread, read_revision: previous.revision }]);
    fold = createWorkspaceInboxFoldStore(
      maintenanceConfig(
        parseDatabaseConfig({
          connectionString: fixture.databaseUrl(process.env.DATABASE_URL ?? ''),
          max: 1,
        }),
      ),
    );
    const changes = await fold.foldPending(10);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.workspaceId).toBe(workspace);
    const stored = (
      await admin.query<{
        id: string;
        revision: string;
        occurrence_count: string;
        latest_kind: string;
        latest_run_id: string;
      }>(
        'select id,revision::text,occurrence_count::text,latest_kind,latest_run_id from app.workspace_inbox_threads',
      )
    ).rows[0];
    expect(stored).toMatchObject({
      id: thread,
      occurrence_count: '6',
      latest_kind: 'timed_out',
      latest_run_id: run,
    });
    expect(BigInt(stored?.revision ?? '0')).toBeGreaterThan(
      BigInt(previous.revision),
    );
    expect(
      (
        await admin.query(
          'select thread_id,read_revision::text from app.workspace_inbox_reads',
        )
      ).rows,
    ).toEqual([{ thread_id: thread, read_revision: previous.revision }]);
    expect(
      (await admin.query('select id from app.workspace_inbox_events')).rows,
    ).toEqual([]);
    expect(await fold.foldPending(10)).toEqual([]);
    expect(await migrateDatabase(config)).toEqual([]);
  } finally {
    await fold?.close();
    await admin?.end();
    await fixture.drop();
  }
});
