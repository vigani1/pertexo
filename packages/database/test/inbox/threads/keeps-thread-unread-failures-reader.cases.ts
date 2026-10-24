import { expect, it } from 'vitest';

import {
  inbox,
  threadId,
  asAdmin,
  workflow,
  seed,
  fail,
  drain,
  reader,
} from './fixture.js';

export function registerKeepsThreadUnreadFailuresReader(): void {
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
      failureDays: [],
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
    const current = await fail(workspaceId, first);
    const recent = await fail(workspaceId, first, { kind: 'timed_out' });
    const old = await fail(workspaceId, first);
    await asAdmin(
      `update app.workflow_runs set completed_at=now() where workspace_id=$1 and id=$2`,
      [workspaceId, current],
    );
    await asAdmin(
      `update app.workflow_runs set completed_at=now() where workspace_id=$1 and id=$2`,
      [workspaceId, recent],
    );
    await asAdmin(
      `update app.workflow_runs set completed_at=now()-interval '31 days' where workspace_id=$1 and id=$2`,
      [workspaceId, old],
    );
    const foreign = await seed();
    const foreignRun = await fail(foreign.workspaceId, foreign.first);
    await asAdmin(
      `update app.workflow_runs set completed_at=now() where workspace_id=$1 and id=$2`,
      [foreign.workspaceId, foreignRun],
    );
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
}
