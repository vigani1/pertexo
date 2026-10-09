import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../src/migrations.js';
import {
  createIdentityWorkspaceDatabase,
  createWorkspaceDatabase,
  parseDatabaseConfig,
  workspaceMemberships,
} from '../src/testing.js';
import { createWorkspaceInboxFoldStore } from '../src/execution/workspace-inbox/inbox-fold-store.js';
import { persistWorkspaceInboxEvent } from '../src/execution/workspace-inbox/inbox-producer.js';
import { createWorkspaceInboxDatabase } from '../src/execution/workspace-inbox/inbox-read-store.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

type Role = 'owner' | 'admin' | 'builder' | 'operator' | 'viewer';
type Kind = 'failed' | 'timed_out' | 'outcome_unknown';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const fixture = createDisposableDatabaseFixture({
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
const apiUrl = url(
  'DATABASE_URL',
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
);
const workerUrl = url(
  'DATABASE_URL',
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
);

let identity: ReturnType<typeof createIdentityWorkspaceDatabase>;
let tenant: ReturnType<typeof createWorkspaceDatabase>;
let fold: ReturnType<typeof createWorkspaceInboxFoldStore>;
let inbox: ReturnType<typeof createWorkspaceInboxDatabase>;
let admin: Pool;
let worker: Pool;

beforeAll(async () => {
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
}, 60_000);

afterAll(async () => {
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
});

async function asAdmin<Row extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<Row[]> {
  return (await admin.query<Row>(text, values)).rows;
}

/** Runs one statement as a runtime role inside a workspace's tenant context. */
async function asMaintenance<Row extends Record<string, unknown>>(
  workspaceId: string,
  text: string,
  values: unknown[] = [],
): Promise<Row[]> {
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_maintenance');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const { rows } = await client.query<Row>(text, values);
    await client.query('commit');
    return rows;
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function user(name: string): Promise<string> {
  return (
    await identity.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: name,
    })
  ).id;
}

async function workflow(workspaceId: string, createdBy: string) {
  const id = randomUUID();
  await asAdmin(
    'insert into app.workflows (id,workspace_id,name,created_by) values ($1,$2,$3,$4)',
    [id, workspaceId, `Workflow ${id.slice(0, 8)}`, createdBy],
  );
  return id;
}

/** A workspace with one member of every role and two workflows. */
async function seed() {
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
async function fail(
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

async function threads(workspaceId: string) {
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

async function pending(workspaceId: string) {
  const [row] = await asAdmin<{ count: number }>(
    'select count(*)::int as count from app.workspace_inbox_events where workspace_id=$1',
    [workspaceId],
  );
  return row?.count;
}

async function drain() {
  for (let round = 0; round < 50; round += 1)
    if ((await fold.foldPending(1_000)).length === 0) return;
  throw new Error('Pending failures did not drain');
}

const reader = (workspaceId: string, actorId: string) => ({
  workspaceId,
  actorId,
});

describe('workspace inbox threads (ADR 055)', () => {
  it('accepts the reviewed fold commands at startup', async () => {
    await expect(fold.checkReadiness()).resolves.toBeUndefined();
  });

  it('records a failure once, only as the worker in its own workspace', async () => {
    const { workspaceId, first } = await seed();
    const runId = await fail(workspaceId, first);
    await fail(workspaceId, first, { runId });
    expect(await pending(workspaceId)).toBe(1);
    await fail(workspaceId, first, { cancellationRequested: true });
    expect(await pending(workspaceId)).toBe(1);

    const other = await seed();
    await expect(
      fail(workspaceId, first, { contextWorkspaceId: other.workspaceId }),
    ).rejects.toMatchObject({ code: '42501' });
    const api = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      await expect(
        api.query(
          `insert into app.workspace_inbox_events
             (id,workspace_id,workflow_id,run_id,terminal_event_sequence,kind,occurred_at)
           values ($1,$2,$3,$4,1,'failed',now())`,
          [randomUUID(), workspaceId, first, runId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await api.end();
    }
  });

  it('folds failures into one thread per workflow and consumes them', async () => {
    const { workspaceId, first, second } = await seed();
    const now = Date.now();
    await fail(workspaceId, first, {
      occurredAt: new Date(now - 3_000).toISOString(),
    });
    const latestRun = await fail(workspaceId, first, {
      kind: 'timed_out',
      occurredAt: new Date(now - 1_000).toISOString(),
    });
    await fail(workspaceId, first, {
      occurredAt: new Date(now - 2_000).toISOString(),
    });
    await fail(workspaceId, second, { kind: 'outcome_unknown' });

    const changes = await fold.foldPending(1_000);
    const change = changes.find((item) => item.workspaceId === workspaceId);
    expect(change?.revision).toMatch(/^[1-9]\d*$/u);
    expect(await pending(workspaceId)).toBe(0);
    const [byFirst, bySecond] = [first, second].map((id) =>
      threads(workspaceId).then((rows) =>
        rows.find((row) => row.workflow_id === id),
      ),
    );
    await expect(byFirst).resolves.toMatchObject({
      occurrence_count: '3',
      latest_kind: 'timed_out',
      latest_run_id: latestRun,
    });
    await expect(bySecond).resolves.toMatchObject({
      occurrence_count: '1',
      latest_kind: 'outcome_unknown',
    });

    const before = (await threads(workspaceId)).find(
      (row) => row.workflow_id === first,
    );
    await fail(workspaceId, first);
    await drain();
    const after = (await threads(workspaceId)).find(
      (row) => row.workflow_id === first,
    );
    expect(after?.occurrence_count).toBe('4');
    expect(BigInt(after?.revision ?? '0')).toBeGreaterThan(
      BigInt(before?.revision ?? '0'),
    );
  });

  it('never counts a failure twice across concurrent folds', async () => {
    const { workspaceId, first, second, members } = await seed();
    const third = await workflow(workspaceId, members.owner);
    const workflows = [first, second, third];
    for (let index = 0; index < 90; index += 1)
      await fail(workspaceId, workflows[index % 3] ?? first);
    for (
      let round = 0;
      round < 20 && (await pending(workspaceId)) !== 0;
      round += 1
    )
      await Promise.all(Array.from({ length: 4 }, () => fold.foldPending(7)));
    expect(await pending(workspaceId)).toBe(0);
    const counts = (await threads(workspaceId)).map((row) =>
      Number(row.occurrence_count),
    );
    expect(counts).toEqual([30, 30, 30]);
  });

  it('starts a thread over once it has been idle for 30 days', async () => {
    const { workspaceId, first } = await seed();
    await fail(workspaceId, first);
    await fail(workspaceId, first);
    await drain();
    await asAdmin(
      `update app.workspace_inbox_threads
          set first_occurred_at=now()-interval '40 days',
              latest_occurred_at=now()-interval '31 days'
        where workspace_id=$1`,
      [workspaceId],
    );
    await fail(workspaceId, first);
    await drain();
    const [thread] = await threads(workspaceId);
    expect(thread?.occurrence_count).toBe('1');
  });

  it('consumes failures of a workspace being purged without a thread', async () => {
    const { workspaceId, first, members } = await seed();
    await fail(workspaceId, first);
    await asAdmin(
      `update app.workspaces
          set status='purging',deletion_requested_at=now()-interval '31 days',
              deletion_requested_by=$2,deletion_reason='Inbox purge',
              purge_after=now()-interval '1 day'
        where id=$1`,
      [workspaceId, members.owner],
    );
    await drain();
    expect(await pending(workspaceId)).toBe(0);
    await expect(threads(workspaceId)).resolves.toEqual([]);
  });

  it('shows threads only to eligible readers of an active workspace', async () => {
    const { workspaceId, first, members } = await seed();
    const other = await seed();
    await fail(workspaceId, first);
    await fail(other.workspaceId, other.first);
    await drain();
    const visible = async (actorId: string, workspace = workspaceId) =>
      (
        await inbox.listThreads({
          ...reader(workspace, actorId),
          filter: 'all',
          limit: 10,
        })
      ).items.map((item) => item.workflowId);

    for (const role of ['owner', 'admin', 'operator'] as const)
      await expect(visible(members[role])).resolves.toEqual([first]);
    for (const role of ['builder', 'viewer'] as const)
      await expect(visible(members[role])).resolves.toEqual([]);
    await expect(visible(members.owner, other.workspaceId)).resolves.toEqual(
      [],
    );

    await asAdmin(
      "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
      [workspaceId, members.operator],
    );
    await expect(visible(members.operator)).resolves.toEqual([]);
    await asAdmin("update app.users set status='suspended' where id=$1", [
      members.admin,
    ]);
    await expect(visible(members.admin)).resolves.toEqual([]);
    await asAdmin("update app.workspaces set status='suspended' where id=$1", [
      workspaceId,
    ]);
    await expect(visible(members.owner)).resolves.toEqual([]);
  });

  it('hides a thread from readers once its latest failure is 30 days old', async () => {
    const { workspaceId, first, members } = await seed();
    await fail(workspaceId, first);
    await drain();
    await asAdmin(
      `update app.workspace_inbox_threads
          set first_occurred_at=now()-interval '31 days',
              latest_occurred_at=now()-interval '31 days'
        where workspace_id=$1`,
      [workspaceId],
    );
    await expect(
      inbox.readSummary(reader(workspaceId, members.owner)),
    ).resolves.toMatchObject({ unreadCount: 0 });
  });

  it('keeps a thread unread for failures its reader has not seen', async () => {
    const { workspaceId, first, second, members } = await seed();
    await fail(workspaceId, first);
    await fail(workspaceId, second);
    await drain();
    const owner = reader(workspaceId, members.owner);
    const page = await inbox.listThreads({
      ...owner,
      filter: 'all',
      limit: 10,
    });
    expect(page.items.map((item) => item.unread)).toEqual([true, true]);
    await expect(inbox.readSummary(owner)).resolves.toMatchObject({
      unreadCount: 2,
    });

    const seen = page.items.find((item) => item.workflowId === first);
    if (seen === undefined) throw new Error('Expected the first thread');
    await expect(
      inbox.markThreadRead({
        ...owner,
        workflowId: first,
        revision: seen.revision,
      }),
    ).resolves.toEqual({ unread: false, revision: seen.revision });
    await expect(inbox.readSummary(owner)).resolves.toMatchObject({
      unreadCount: 1,
    });
    // Reading is private to each reader.
    await expect(
      inbox.readSummary(reader(workspaceId, members.admin)),
    ).resolves.toMatchObject({ unreadCount: 2 });

    // A new failure makes it unread again; the older revision cannot hide it.
    await fail(workspaceId, first);
    await drain();
    const again = await inbox.markThreadRead({
      ...owner,
      workflowId: first,
      revision: seen.revision,
    });
    expect(again?.unread).toBe(true);
    // Asking for more than the thread's revision reads only what exists.
    await inbox.markThreadRead({
      ...owner,
      workflowId: first,
      revision: '999999999999',
    });
    await fail(workspaceId, first);
    await drain();
    await expect(inbox.readSummary(owner)).resolves.toMatchObject({
      unreadCount: 2,
    });
    await expect(
      inbox.markThreadRead({
        ...reader(workspaceId, members.viewer),
        workflowId: first,
        revision: seen.revision,
      }),
    ).resolves.toBeUndefined();
  });

  it('marks all read only up to the cut the reader saw', async () => {
    const { workspaceId, first, second, members } = await seed();
    const later = await workflow(workspaceId, members.owner);
    await fail(workspaceId, first);
    await fail(workspaceId, second);
    await drain();
    const owner = reader(workspaceId, members.owner);
    const { revision } = await inbox.readSummary(owner);
    await fail(workspaceId, later);
    await drain();
    await expect(inbox.markAllRead({ ...owner, revision })).resolves.toEqual({
      marked: 2,
    });
    const unread = await inbox.listThreads({
      ...owner,
      filter: 'unread',
      limit: 10,
    });
    expect(unread.items.map((item) => item.workflowId)).toEqual([later]);
    await expect(inbox.markAllRead({ ...owner, revision })).resolves.toEqual({
      marked: 0,
    });
  });

  it('pages newest first with a stable keyset cursor', async () => {
    const { workspaceId, first, second, members } = await seed();
    const third = await workflow(workspaceId, members.owner);
    const now = Date.now();
    await fail(workspaceId, first, {
      occurredAt: new Date(now - 3_000).toISOString(),
    });
    await fail(workspaceId, second, {
      occurredAt: new Date(now - 2_000).toISOString(),
    });
    await fail(workspaceId, third, {
      occurredAt: new Date(now - 1_000).toISOString(),
    });
    await drain();
    const owner = reader(workspaceId, members.owner);
    const firstPage = await inbox.listThreads({
      ...owner,
      filter: 'all',
      limit: 2,
    });
    expect(firstPage.items.map((item) => item.workflowId)).toEqual([
      third,
      second,
    ]);
    if (firstPage.next === null) throw new Error('Expected a next page');
    const secondPage = await inbox.listThreads({
      ...owner,
      filter: 'all',
      limit: 2,
      after: firstPage.next,
    });
    expect(secondPage.items.map((item) => item.workflowId)).toEqual([first]);
    expect(secondPage.next).toBeNull();
    expect(firstPage.items[0]?.workflowName).toMatch(/^Workflow /u);
    expect(firstPage.items[0]).toMatchObject({
      occurrenceCount: 1,
      kind: 'failed',
      latestFailedStep: null,
    });
  });

  it('never moves a read backwards', async () => {
    const { workspaceId, first, members } = await seed();
    await fail(workspaceId, first);
    await drain();
    const owner = reader(workspaceId, members.owner);
    const { revision } = await inbox.readSummary(owner);
    await inbox.markThreadRead({ ...owner, workflowId: first, revision });
    await asAdmin(
      'update app.workspace_inbox_reads set read_revision=1 where workspace_id=$1',
      [workspaceId],
    );
    const [read] = await asAdmin<{ read_revision: string }>(
      'select read_revision::text from app.workspace_inbox_reads where workspace_id=$1',
      [workspaceId],
    );
    expect(read?.read_revision).toBe(revision);
  });

  it('expires idle threads with their reads', async () => {
    const idle = await seed();
    await fail(idle.workspaceId, idle.first);
    await drain();
    const owner = reader(idle.workspaceId, idle.members.owner);
    const { revision } = await inbox.readSummary(owner);
    await inbox.markThreadRead({
      ...owner,
      workflowId: idle.first,
      revision,
    });
    await asAdmin(
      `update app.workspace_inbox_threads
          set first_occurred_at=now()-interval '31 days',
              latest_occurred_at=now()-interval '31 days'
        where workspace_id=$1`,
      [idle.workspaceId],
    );
    for (let round = 0; round < 10; round += 1)
      if ((await fold.expireThreads(1_000)) === 0) break;
    await expect(threads(idle.workspaceId)).resolves.toEqual([]);
    await expect(
      asAdmin('select 1 from app.workspace_inbox_reads where workspace_id=$1', [
        idle.workspaceId,
      ]),
    ).resolves.toEqual([]);
  });

  it('is erased by the workspace purge before its parents', async () => {
    const { workspaceId, first, members } = await seed();
    const other = await seed();
    for (const target of [
      { workspaceId, workflowId: first },
      { workspaceId: other.workspaceId, workflowId: other.first },
    ])
      await fail(target.workspaceId, target.workflowId);
    await drain();
    await inbox.markAllRead({
      ...reader(workspaceId, members.owner),
      revision: (await inbox.readSummary(reader(workspaceId, members.owner)))
        .revision,
    });
    // A failure recorded after the last fold is still pending at purge time.
    await fail(workspaceId, first);
    const counts = async (target: string) =>
      asAdmin<{ events: number; threads: number; reads: number }>(
        `select
           (select count(*)::int from app.workspace_inbox_events where workspace_id=$1) events,
           (select count(*)::int from app.workspace_inbox_threads where workspace_id=$1) threads,
           (select count(*)::int from app.workspace_inbox_reads where workspace_id=$1) reads`,
        [target],
      );
    await expect(counts(workspaceId)).resolves.toEqual([
      { events: 1, threads: 1, reads: 1 },
    ]);

    // Arrange ledger projections with the existing maintenance authority.
    const maintenance = (text: string, values: unknown[]) =>
      asMaintenance<Record<string, unknown>>(workspaceId, text, values);
    const requestedHash = '1'.repeat(64);
    const startedHash = '2'.repeat(64);
    await maintenance(
      `select app.project_workspace_deletion(
         $1,1,$2,'deletion_requested',$1,$3,$4,$5,null,
         'Inbox purge qualification',clock_timestamp()-interval '31 days')`,
      [workspaceId, randomUUID(), '0'.repeat(64), requestedHash, members.owner],
    );
    const [prepared] = await maintenance(
      `select * from app.prepare_workspace_purge_job(
         $1,1,$2,'inbox-threads-test',interval '1 minute')`,
      [workspaceId, requestedHash],
    );
    if (prepared === undefined) throw new Error('Expected a purge job');
    await maintenance(
      'select app.project_workspace_purge_started($1,$2,$3,2,$4,$5)',
      [
        prepared.job_id,
        prepared.lease_token,
        prepared.lease_fence,
        requestedHash,
        startedHash,
      ],
    );
    const claim = async () => {
      const [step] = await maintenance(
        `select * from app.claim_workspace_purge_step(
           $1,2,$2,'inbox-threads-test',interval '1 minute')`,
        [prepared.job_id, startedHash],
      );
      if (step === undefined) throw new Error('Expected a purge step');
      return step;
    };
    const objects = await claim();
    expect(objects.step_name).toBe('object_versions');
    await maintenance(
      'select app.checkpoint_workspace_object_versions_page($1,$2,$3,0,true,2,$4)',
      [prepared.job_id, objects.lease_token, objects.lease_fence, startedHash],
    );

    const erased: unknown[] = [];
    let lease = await claim();
    for (let page = 0; page < 100; page += 1) {
      expect(lease.step_name).toBe('tenant_rows');
      const [result] = await maintenance(
        `select * from app.execute_workspace_tenant_rows_page(
           $1,$2,$3,1,2,$4)`,
        [prepared.job_id, lease.lease_token, lease.lease_fence, startedHash],
      );
      if (result === undefined) throw new Error('Expected a purge page');
      if (
        typeof result.surface === 'string' &&
        result.surface.startsWith('workspace_inbox_') &&
        !erased.includes(result.surface)
      )
        erased.push(result.surface);
      if (result.completed === true) break;
      lease = await claim();
    }
    expect(erased).toEqual([
      'workspace_inbox_reads',
      'workspace_inbox_threads',
      'workspace_inbox_events',
    ]);
    await expect(counts(workspaceId)).resolves.toEqual([
      { events: 0, threads: 0, reads: 0 },
    ]);
    await expect(counts(other.workspaceId)).resolves.toEqual([
      { events: 0, threads: 1, reads: 0 },
    ]);
  });
});
