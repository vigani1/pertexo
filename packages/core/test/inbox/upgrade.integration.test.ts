import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  createDisposableDatabaseFixture,
  migrateDatabase,
} from '@pertexo/database/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { createWorkspaceInboxStore } from '../../src/inbox/threads/workspace-inbox.store.js';
it('upgrades populated workflow threads and private read revisions without changing their cut or precision', async () => {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_notice_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });

  let admin: Pool | undefined;
  let read: ReturnType<typeof createWorkspaceInboxStore> | undefined;
  try {
    await fixture.create();

    const migration = {
      appRole: 'pertexo_app',
      ownerRole: 'pertexo_owner',
      maintenanceRole: 'pertexo_maintenance',
      connectionString: fixture.databaseUrl(
        process.env.DATABASE_MIGRATION_URL ??
          'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
      ),
    };
    await migrateDatabase(migration);
    admin = new Pool({
      connectionString: fixture.databaseUrl(adminUrl),
      max: 1,
    });
    const owner = randomUUID(),
      workspaceId = randomUUID(),
      workflowId = randomUUID(),
      runId = randomUUID();
    await admin.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Upgrade owner')",
      [owner, `${owner}@example.test`],
    );
    await admin.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Upgrade proof',$2,$3)",
      [workspaceId, `upgrade-${workspaceId}`, owner],
    );
    await admin.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')",
      [workspaceId, owner],
    );
    await admin.query(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Preserved workflow',$3)",
      [workflowId, workspaceId, owner],
    );
    const old = await admin.query<{ revision: string; latest: string }>(
      "insert into app.workspace_inbox_threads(workspace_id,id,notice_kind,subject_id,workflow_id,revision,occurrence_count,first_occurred_at,latest_occurred_at,latest_run_id,latest_kind) values($1,$2,'workflow_failure',$2,$2,nextval('app.workspace_inbox_revision_seq'),3,clock_timestamp()-interval '1 hour',clock_timestamp(),$3,'failed') returning revision::text,to_char(latest_occurred_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') latest",
      [workspaceId, workflowId, runId],
    );
    const before = old.rows[0];
    if (before === undefined) throw new Error('Expected old thread');
    await admin.query(
      'insert into app.workspace_inbox_reads(workspace_id,user_id,thread_id,read_revision) values($1,$2,$3,$4)',
      [workspaceId, owner, workflowId, before.revision],
    );

    read = createWorkspaceInboxStore(
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(
          process.env.DATABASE_URL ??
            'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
        ),
        max: 1,
      }),
    );
    const page = await read.listThreads({
      workspaceId,
      actorId: owner,
      filter: 'all',
      limit: 25,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      noticeKind: 'workflow_failure',
      workflowId,
      revision: before.revision,
      unread: false,
      occurrenceCount: 3,
      latestOccurredAt: before.latest,
      latestRunId: runId,
    });
    const migrated = await admin.query<{
      thread_id: string;
      read_revision: string;
    }>(
      'select thread_id,read_revision::text from app.workspace_inbox_reads where workspace_id=$1',
      [workspaceId],
    );
    expect(migrated.rows).toEqual([
      { thread_id: page.items[0]?.id, read_revision: before.revision },
    ]);
  } finally {
    await read?.close();
    await admin?.end();
    await fixture.drop();
  }
}, 60_000);
