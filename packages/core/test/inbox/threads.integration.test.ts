import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beforeAllFixture1,
  afterAllFixture2,
  apiUrl,
  fold,
  inbox,
  asAdmin,
  workflow,
  seed,
  fail,
  threads,
  pending,
  drain,
  reader,
  threadId,
  adminUrl,
  fixture,
  maintenanceUrl,
} from './workflow-threads.fixture.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { enforceRetention } from '../support/retention.js';
import { purgeWorkspace } from '../support/workspace-purge.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);
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

  it('shows threads only to eligible readers of a workspace that can be browsed', async () => {
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
    // A suspended workspace reads but does not change (ADR 013/027).
    await asAdmin("update app.workspaces set status='suspended' where id=$1", [
      workspaceId,
    ]);
    await expect(visible(members.owner)).resolves.toHaveLength(1);
    await asAdmin(
      `update app.workspaces set status='pending_deletion',
         deletion_requested_at=clock_timestamp(),
         deletion_requested_by=created_by, deletion_reason='Closing',
         purge_after=clock_timestamp()+interval '30 days'
       where id=$1`,
      [workspaceId],
    );
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
        threadId: await threadId(workspaceId, first),
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
      threadId: await threadId(workspaceId, first),
      revision: seen.revision,
    });
    expect(again?.unread).toBe(true);
    // Asking for more than the thread's revision reads only what exists.
    await inbox.markThreadRead({
      ...owner,
      threadId: await threadId(workspaceId, first),
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
        threadId: await threadId(workspaceId, first),
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
    expect(
      firstPage.items.find((t) => t.noticeKind === 'workflow_failure')
        ?.workflowName,
    ).toMatch(/^Workflow /u);
    expect(firstPage.items[0]).toMatchObject({
      failureDays: [{ day: new Date().toISOString().slice(0, 10), count: 1 }],
      occurrenceCount: 1,
      kind: 'failed',
      latestFailedStep: null,
    });
  });

  it('keeps microsecond timestamp ties stable across one-thread pages', async () => {
    const { workspaceId, first, second, members } = await seed();
    const third = await workflow(workspaceId, members.owner);
    for (const workflowId of [first, second, third])
      await fail(workspaceId, workflowId);
    await drain();
    await asAdmin(
      `update app.workspace_inbox_threads
       set first_occurred_at=date_trunc('second',statement_timestamp())+interval '0.123456 seconds',
           latest_occurred_at=date_trunc('second',statement_timestamp())+interval '0.123456 seconds'
       where workspace_id=$1 and notice_kind='workflow_failure'`,
      [workspaceId],
    );
    const input = {
      ...reader(workspaceId, members.owner),
      filter: 'all' as const,
      noticeKind: 'workflow_failure' as const,
      limit: 1,
    };
    const firstPage = await inbox.listThreads(input);
    expect(firstPage.next?.latestOccurredAt).toMatch(/\.123456Z$/u);
    if (firstPage.next === null) throw new Error('Expected a second page');
    const secondPage = await inbox.listThreads({
      ...input,
      after: firstPage.next,
    });
    if (secondPage.next === null) throw new Error('Expected a third page');
    const thirdPage = await inbox.listThreads({
      ...input,
      after: secondPage.next,
    });
    expect(thirdPage.next).toBeNull();
    expect(
      [...firstPage.items, ...secondPage.items, ...thirdPage.items]
        .map((item) => item.workflowId)
        .sort(),
    ).toEqual([first, second, third].sort());
  });

  it('returns retained UTC failure days and excludes old or foreign runs', async () => {
    const { workspaceId, first, members } = await seed();
    await fail(workspaceId, first);
    await fail(workspaceId, first, { kind: 'timed_out' });
    await fail(workspaceId, first, {
      occurredAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const foreign = await seed();
    await fail(foreign.workspaceId, foreign.first);
    await drain();
    const page = await inbox.listThreads({
      ...reader(workspaceId, members.owner),
      filter: 'all',
      limit: 10,
    });
    expect(page.items).toHaveLength(1);
    expect(
      page.items.find((t) => t.noticeKind === 'workflow_failure')?.failureDays,
    ).toEqual([{ day: new Date().toISOString().slice(0, 10), count: 2 }]);
  });

  it('never moves a read backwards', async () => {
    const { workspaceId, first, members } = await seed();
    await fail(workspaceId, first);
    await drain();
    const owner = reader(workspaceId, members.owner);
    const { revision } = await inbox.readSummary(owner);
    await inbox.markThreadRead({
      ...owner,
      threadId: await threadId(workspaceId, first),
      revision,
    });
    expect(BigInt(revision)).toBeGreaterThan(1n);
    await inbox.markThreadRead({
      ...owner,
      threadId: await threadId(workspaceId, first),
      revision: '1',
    });
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
      threadId: await threadId(idle.workspaceId, idle.first),
      revision,
    });
    await asAdmin(
      `update app.workspace_inbox_threads
          set first_occurred_at=now()-interval '31 days',
              latest_occurred_at=now()-interval '31 days'
        where workspace_id=$1`,
      [idle.workspaceId],
    );
    await enforceRetention(maintenanceUrl);
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

    const steps = await purgeWorkspace({
      adminUrl: fixture.databaseUrl(adminUrl),
      maintenanceUrl,
      workspaceId,
      pageSize: 1,
    });
    const erased = [
      ...new Set(steps.filter((step) => step.startsWith('workspace_inbox_'))),
    ];
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
