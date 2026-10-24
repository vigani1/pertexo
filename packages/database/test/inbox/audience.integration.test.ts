import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { apiPool } from '../support/workflow-authoring.js';
import { withTenantScopedClient } from '../../src/tenant-access/transactions.js';
import { createPendingTaskStore } from '../../src/runs/pending-tasks/responses/repository.js';
import {
  own,
  config,
  preferences,
  inbox,
  observer,
  seedNoticeWorkspace,
  seedNoticeWorkflow,
  seedFailure,
  seedApproval,
  queryAsOwner,
} from './notices.fixture.js';

it('filters before pagination, revisions and read commands while SQL keeps only the member fence', async () => {
  const f = await seedNoticeWorkspace();
  await seedFailure(f.workspaceId, f.workflowId);
  for (let index = 0; index < 60; index++) {
    const workflow = await seedNoticeWorkflow(f.workspaceId, f.members.owner);
    await seedFailure(f.workspaceId, workflow);
  }
  await observer().foldPending(1000);
  const viewer = { workspaceId: f.workspaceId, actorId: f.members.viewer };
  const choice = {
    ...viewer,
    subjectKind: 'workflow' as const,
    subjectId: f.workflowId,
  };
  const prefs = preferences();
  await prefs.replaceSubscription({
    ...choice,
    followed: true,
    muted: false,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const read = inbox();
  const page = await read.listThreads({ ...viewer, filter: 'all', limit: 2 });
  expect(page.items).toMatchObject([
    { noticeKind: 'workflow_failure', workflowId: f.workflowId },
  ]);
  expect(page.next).toBeNull();
  const thread = page.items[0];
  if (thread === undefined) throw new Error('Expected followed thread');
  expect(await read.readSummary(viewer)).toEqual({
    unreadCount: 1,
    revision: thread.revision,
  });
  expect(page.revision).toBe(thread.revision);
  const raw = await withTenantScopedClient(apiPool, viewer, (client) =>
    client.query<{ count: number }>(
      'select count(*)::int count from app.workspace_inbox_threads where workspace_id=$1',
      [f.workspaceId],
    ),
  );
  expect(raw.rows).toEqual([{ count: 61 }]);
  expect(
    await read.markAllRead({ ...viewer, revision: '9223372036854775807' }),
  ).toEqual({ marked: 1 });
  expect(await read.readSummary(viewer)).toEqual({
    unreadCount: 0,
    revision: thread.revision,
  });
  const hidden = await queryAsOwner<{ id: string }>(
    'select id from app.workspace_inbox_threads where workspace_id=$1 and workflow_id<>$2 limit 1',
    [f.workspaceId, f.workflowId],
    f.workspaceId,
  );
  const hiddenId = hidden[0]?.id;
  if (hiddenId === undefined) throw new Error('Expected hidden subject');
  expect(
    await read.markThreadRead({
      ...viewer,
      threadId: hiddenId,
      revision: '9223372036854775807',
    }),
  ).toBeUndefined();
  expect(
    await queryAsOwner<{ count: number }>(
      'select count(*)::int count from app.workspace_inbox_reads where workspace_id=$1 and user_id=$2',
      [f.workspaceId, viewer.actorId],
      f.workspaceId,
    ),
  ).toEqual([{ count: 1 }]);
  await prefs.replaceSubscription({
    ...choice,
    followed: false,
    muted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(await read.readSummary(viewer)).toEqual({
    unreadCount: 0,
    revision: '0',
  });
  expect(
    await read.markThreadRead({
      ...viewer,
      threadId: thread.id,
      revision: thread.revision,
    }),
  ).toBeUndefined();
  const foreign = await seedNoticeWorkspace();
  await seedFailure(foreign.workspaceId, foreign.workflowId);
  await observer().foldPending(1000);
  const isolated = await withTenantScopedClient(apiPool, viewer, (client) =>
    client.query(
      'select id from app.workspace_inbox_threads where workspace_id=$1',
      [foreign.workspaceId],
    ),
  );
  expect(isolated.rows).toEqual([]);
  await queryAsOwner(
    "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
    [f.workspaceId, viewer.actorId],
    f.workspaceId,
  );
  expect(
    (await read.listThreads({ ...viewer, filter: 'all', limit: 2 })).items,
  ).toEqual([]);
  const suspended = await withTenantScopedClient(apiPool, viewer, (client) =>
    client.query<{ count: number }>(
      'select count(*)::int count from app.workspace_inbox_threads where workspace_id=$1',
      [f.workspaceId],
    ),
  );
  expect(suspended.rows).toEqual([{ count: 0 }]);
});

it('keeps muted approvals in the task list and immediately hides resolved notice context without waiting for observation', async () => {
  const f = await seedNoticeWorkspace();
  const { taskId } = await seedApproval(f.workspaceId, f.workflowId, {
    starter: f.members.owner,
    named: f.members.viewer,
  });
  await queryAsOwner(
    'update app.pending_run_tasks set context=$2::jsonb where id=$1',
    [taskId, JSON.stringify({ details: { Amount: 120 } })],
  );
  await observer().observeCurrent?.();
  const scope = { workspaceId: f.workspaceId, actorId: f.members.viewer };
  const read = inbox();
  const list = () => read.listThreads({ ...scope, filter: 'all', limit: 2 });
  expect((await list()).items).toMatchObject([
    { noticeKind: 'approval_waiting', details: { Amount: 120 } },
  ]);
  const prefs = preferences();
  const choice = {
    ...scope,
    subjectKind: 'workflow' as const,
    subjectId: f.workflowId,
    followed: false,
  };
  await prefs.replaceSubscription({
    ...choice,
    muted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  expect((await list()).items).toEqual([]);
  const tasks = own(createPendingTaskStore(config()));
  expect(
    (
      await tasks.list({
        ...scope,
        kind: 'approval',
        view: 'mine',
        status: 'pending',
      })
    ).items,
  ).toMatchObject([{ id: taskId, canRespond: true, details: { Amount: 120 } }]);
  await prefs.replaceSubscription({
    ...choice,
    muted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect((await list()).items).toHaveLength(1);
  await queryAsOwner(
    "update app.pending_run_tasks set status='canceled',completed_at=clock_timestamp() where id=$1",
    [taskId],
  );
  expect((await list()).items).toEqual([]);
  expect(await read.readSummary(scope)).toEqual({
    unreadCount: 0,
    revision: '0',
  });
  expect(
    await read.markAllRead({ ...scope, revision: '9223372036854775807' }),
  ).toEqual({ marked: 0 });
});

it('shows approval notices to starters only when the captured step permits it', async () => {
  const f = await seedNoticeWorkspace();
  await seedApproval(f.workspaceId, f.workflowId, { starter: f.members.owner });
  await observer().observeCurrent?.();
  const scope = { workspaceId: f.workspaceId, actorId: f.members.owner };
  expect(
    (
      await inbox().listThreads({ ...scope, filter: 'all', limit: 50 })
    ).items.filter((item) => item.noticeKind === 'approval_waiting'),
  ).toHaveLength(0);
  await seedApproval(f.workspaceId, f.workflowId, {
    starter: f.members.owner,
    named: undefined,
    allowStarterToDecide: true,
  });
  await observer().observeCurrent?.();
  expect(
    (
      await inbox().listThreads({ ...scope, filter: 'all', limit: 50 })
    ).items.filter((item) => item.noticeKind === 'approval_waiting'),
  ).toHaveLength(1);
});
