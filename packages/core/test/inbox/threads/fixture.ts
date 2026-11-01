import { createTestUser } from '../../support/user.js';
import type { Role } from '@pertexo/workflow-model';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import {
  migrateDatabase,
  createWorkspaceDatabase,
  parseDatabaseConfig,
  workspaceMemberships,
  createDisposableDatabaseFixture,
} from '@pertexo/database/testing';
import { createIdentityWorkspaceDatabase } from '../../../src/testing.js';
import { createWorkspaceInboxFoldStore } from '../../../src/inbox/folding/store.js';
import { persistWorkspaceInboxEvent } from '../../../src/inbox/folding/events.repository.js';
import { createWorkspaceInboxDatabase } from '../../../src/inbox/threads/store.js';

type Kind = 'failed' | 'timed_out' | 'outcome_unknown';

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

export const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName: `pertexo_test_inbox_threads_${randomUUID().replaceAll('-', '')}`,
  ownerRole: 'pertexo_owner',
});

const url = (variable: string, fallback: string) =>
  fixture.databaseUrl(process.env[variable] ?? fallback);

const migrationUrl = url(
  'DATABASE_MIGRATION_URL',
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
);

export const apiUrl = url(
  'DATABASE_URL',
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
);

const workerUrl = url(
  'DATABASE_URL',
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
);

export const maintenanceUrl = url(
  'DATABASE_MAINTENANCE_URL',
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
);

let identity: ReturnType<typeof createIdentityWorkspaceDatabase>;

let tenant: ReturnType<typeof createWorkspaceDatabase>;

export let fold: ReturnType<typeof createWorkspaceInboxFoldStore>;

export let inbox: ReturnType<typeof createWorkspaceInboxDatabase>;

export let admin: Pool;

let worker: Pool;

export async function threadId(workspaceId: string, workflowId: string) {
  const found = await admin.query<{ id: string }>(
    "select id from app.workspace_inbox_threads where workspace_id=$1 and workflow_id=$2 and notice_kind='workflow_failure'",
    [workspaceId, workflowId],
  );
  const id = found.rows[0]?.id;
  if (id === undefined) throw new Error('Expected folded failure thread');
  return id;
}

export async function asAdmin<Row extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<Row[]> {
  return (await admin.query<Row>(text, values)).rows;
}

async function user(name: string): Promise<string> {
  return (await createTestUser(identity, name)).id;
}

export async function workflow(workspaceId: string, createdBy: string) {
  const id = randomUUID();
  await asAdmin(
    'insert into app.workflows (id,workspace_id,name,created_by) values ($1,$2,$3,$4)',
    [id, workspaceId, `Workflow ${id.slice(0, 8)}`, createdBy],
  );
  return id;
}

/** A workspace with one member of every role and two workflows. */
export async function seed() {
  const owner = await user('Owner');
  const workspaceId = (
    await identity.createWorkspaceWithOwner({
      name: 'Inbox threads',
      slug: `inbox-threads-${randomUUID().slice(0, 8)}`,
      ownerUserId: owner,
    })
  ).id;
  const members: Record<Role, string> = {
    owner,
    admin: await user('Admin'),
    operator: await user('Operator'),
    builder: await user('Builder'),
    viewer: await user('Viewer'),
  };
  for (const role of ['admin', 'operator', 'builder', 'viewer'] as const)
    await tenant.withWorkspace(workspaceId, async ({ db }) => {
      await db.insert(workspaceMemberships).values({
        workspaceId,
        userId: members[role],
        role,
        status: 'active',
      });
    });
  await asAdmin(
    `insert into app.workspace_execution_entitlement_versions
       (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
     values ($1,2,'active',10000,100000,'-infinity'::timestamptz)`,
    [workspaceId],
  );
  await asAdmin(
    'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
    [workspaceId],
  );
  return {
    workspaceId,
    members,
    first: await workflow(workspaceId, owner),
    second: await workflow(workspaceId, owner),
  };
}

/** A terminal failure recorded by the real producer as the worker role. */
export async function fail(
  workspaceId: string,
  workflowId: string,
  options: Readonly<{
    kind?: Kind;
    occurredAt?: string;
    runId?: string;
    sequence?: number;
    cancellationRequested?: boolean;
    contextWorkspaceId?: string;
  }> = {},
) {
  const runId = options.runId ?? randomUUID();
  const kind = options.kind ?? 'failed';
  if (options.runId === undefined)
    // Admission reads the workspace's entitlement under its tenant context.
    await asAdmin(
      `with tenant as (select set_config('app.workspace_id',$2::uuid::text,true))
       insert into app.workflow_runs (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
       select $1::uuid,$2::uuid,$3::uuid,$4::uuid,'manual',$5 from tenant`,
      [runId, workspaceId, workflowId, randomUUID(), kind],
    );
  const client = await worker.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      options.contextWorkspaceId ?? workspaceId,
    ]);
    await persistWorkspaceInboxEvent(client, {
      workspaceId,
      workflowId,
      runId,
      cancellationRequested: options.cancellationRequested ?? false,
      plan: {
        checkpoint: { runStatus: kind },
        events: [
          {
            name: `run.${kind}`,
            sequence: options.sequence ?? 7,
            occurredAt: options.occurredAt ?? new Date().toISOString(),
          },
        ],
      } as never,
    });
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  return runId;
}

export async function threads(workspaceId: string) {
  return asAdmin<{
    workflow_id: string;
    occurrence_count: string;
    latest_kind: string;
    latest_run_id: string;
    revision: string;
  }>(
    `select workflow_id,occurrence_count::text,latest_kind,latest_run_id,revision::text
       from app.workspace_inbox_threads where workspace_id=$1 order by workflow_id`,
    [workspaceId],
  );
}

export async function pending(workspaceId: string) {
  const [row] = await asAdmin<{ count: number }>(
    'select count(*)::int as count from app.workspace_inbox_events where workspace_id=$1',
    [workspaceId],
  );
  return row?.count;
}

export async function drain() {
  for (let round = 0; round < 50; round += 1)
    if ((await fold.foldPending(1_000)).length === 0) return;
  throw new Error('Pending failures did not drain');
}

export const reader = (workspaceId: string, actorId: string) => ({
  workspaceId,
  actorId,
});

export async function beforeAllFixture1() {
  await fixture.create();
  await migrateDatabase({
    appRole: 'pertexo_app',
    connectionString: migrationUrl,
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
  });
  identity = createIdentityWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  );
  tenant = createWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  );
  fold = createWorkspaceInboxFoldStore(
    parseDatabaseConfig({ connectionString: workerUrl, max: 6 }),
  );
  inbox = createWorkspaceInboxDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  );
  admin = new Pool({ connectionString: fixture.databaseUrl(adminUrl), max: 2 });
  worker = new Pool({ connectionString: workerUrl, max: 2 });
}

export async function afterAllFixture2() {
  const closing = await Promise.allSettled([
    identity.close(),
    tenant.close(),
    fold.close(),
    inbox.close(),
    admin.end(),
    worker.end(),
  ]);
  await fixture.drop();
  const failure = closing.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
