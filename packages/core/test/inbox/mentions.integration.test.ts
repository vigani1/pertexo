import { enforceTestRetention } from '../support/workflow-authoring.js';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createWorkflowAuthoringFixtureDatabase } from '../support/workflow-authoring-admission.fixture.js';
import type { NoticeMailToSeal } from '../../src/inbox/mail/contract.js';
import {
  config,
  own,
  seedNoticeWorkspace,
  observer,
  inbox,
  preferences,
  mail,
  queryAsOwner,
} from './notices.fixture.js';
const database = own(createWorkflowAuthoringFixtureDatabase(config()));
function discussions() {
  return database.collaboration;
}
it('notifies only explicit current recipients, preserves identity across edits, and seals safe discussion links', async () => {
  const f = await seedNoticeWorkspace();
  const scope = { ...f.scope, workflowId: f.workflowId };
  const recipient = { ...f.scope, actorId: f.members.viewer };
  await preferences().replace({
    ...recipient,
    mode: 'immediate',
    hour: 9,
    timeZone: 'UTC',
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const body = 'PRIVATE COMMENT ' + randomUUID();
  const root = await discussions().create({
    ...scope,
    idempotencyKey: randomUUID(),
    body,
    mentionUserIds: [f.members.viewer, f.members.owner],
    stepId: null,
  });
  if (root.commentId === null) throw new Error('Comment missing');
  const fold = observer(),
    read = inbox();
  const list = (actorId: string) =>
    read.listThreads({
      ...f.scope,
      actorId,
      filter: 'all',
      noticeKind: 'workflow_mention',
      limit: 20,
    });
  await Promise.all([fold.observeCurrent?.(), observer().observeCurrent?.()]);
  const first = await list(f.members.viewer);
  expect(first.items).toMatchObject([
    {
      noticeKind: 'workflow_mention',
      workflowId: f.workflowId,
      threadId: root.threadId,
      commentId: root.commentId,
      occurrenceCount: 1,
    },
  ]);
  expect((await list(f.members.owner)).items).toEqual([]);
  expect((await list(f.members.admin)).items).toEqual([]);
  expect(JSON.stringify(first)).not.toContain(body);
  const captured: NoticeMailToSeal[] = [];
  const sender = mail(captured);
  await sender.prepare();
  const batch = captured.find((item) => item.actorId === f.members.viewer);
  expect(batch?.items).toMatchObject([
    {
      noticeKind: 'workflow_mention',
      discussion: { threadId: root.threadId, commentId: root.commentId },
    },
  ]);
  expect(JSON.stringify(batch)).not.toContain(body);
  if (batch === undefined) throw new Error('Mention batch missing');
  expect(await sender.authorize(batch.id)).toBe(true);
  await discussions().edit({
    ...scope,
    idempotencyKey: randomUUID(),
    threadId: root.threadId,
    commentId: root.commentId,
    expectedRevision: 1,
    body: body + ' edited',
    mentionUserIds: [f.members.viewer, f.members.owner],
  });
  await fold.observeCurrent?.();
  expect((await list(f.members.viewer)).revision).toBe(first.revision);
  expect(await sender.prepare()).toBe(0);
  await preferences().replaceSubscription({
    ...recipient,
    subjectKind: 'workflow',
    subjectId: f.workflowId,
    followed: false,
    muted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  expect((await list(f.members.viewer)).items).toEqual([]);
  expect(await sender.authorize(batch.id)).toBe(false);
  await discussions().edit({
    ...scope,
    idempotencyKey: randomUUID(),
    threadId: root.threadId,
    commentId: root.commentId,
    expectedRevision: 2,
    body,
    mentionUserIds: [],
  });
  expect(
    await queryAsOwner(
      'select id from app.workspace_inbox_threads where workspace_id=$1 and notice_kind=$2',
      [f.workspaceId, 'workflow_mention'],
      f.workspaceId,
    ),
  ).toEqual([]);
  await discussions().edit({
    ...scope,
    idempotencyKey: randomUUID(),
    threadId: root.threadId,
    commentId: root.commentId,
    expectedRevision: 3,
    body,
    mentionUserIds: [f.members.admin],
  });
  await fold.observeCurrent?.();
  expect((await list(f.members.admin)).items).toHaveLength(1);
  await queryAsOwner(
    "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
    [f.workspaceId, f.members.admin],
    f.workspaceId,
  );
  expect((await list(f.members.admin)).items).toEqual([]);
});
it('uses the original mention time and never recreates expired notifications from retained comments', async () => {
  const f = await seedNoticeWorkspace();
  const root = await discussions().create({
    ...f.scope,
    workflowId: f.workflowId,
    idempotencyKey: randomUUID(),
    body: 'Retained discussion',
    mentionUserIds: [f.members.viewer],
    stepId: null,
  });
  await queryAsOwner(
    "update app.workflow_comment_mentions set created_at=clock_timestamp()-interval '31 days' where workspace_id=$1",
    [f.workspaceId],
    f.workspaceId,
  );
  await observer().observeCurrent?.();
  const list = () =>
    inbox().listThreads({
      ...f.scope,
      actorId: f.members.viewer,
      filter: 'all',
      noticeKind: 'workflow_mention',
      limit: 20,
    });
  expect((await list()).items).toEqual([]);
  expect(
    (
      await discussions().read({
        ...f.scope,
        workflowId: f.workflowId,
        threadId: root.threadId,
        limit: 20,
      })
    ).comments,
  ).toHaveLength(1);
  await queryAsOwner(
    "update app.workflow_comment_mentions set created_at=clock_timestamp()-interval '2 days' where workspace_id=$1",
    [f.workspaceId],
    f.workspaceId,
  );
  await observer().observeCurrent?.();
  expect((await list()).items).toHaveLength(1);
  const [notice] = await queryAsOwner<{ old: boolean }>(
    "select latest_occurred_at<clock_timestamp()-interval '1 day' old from app.workspace_inbox_threads where workspace_id=$1 and notice_kind='workflow_mention'",
    [f.workspaceId],
    f.workspaceId,
  );
  expect(notice?.old).toBe(true);
  await queryAsOwner(
    "update app.workspace_inbox_threads set latest_occurred_at=clock_timestamp()-interval '31 days',first_occurred_at=clock_timestamp()-interval '31 days' where workspace_id=$1",
    [f.workspaceId],
    f.workspaceId,
  );
  await queryAsOwner(
    "update app.workflow_comment_mentions set created_at=clock_timestamp()-interval '31 days' where workspace_id=$1",
    [f.workspaceId],
    f.workspaceId,
  );
  // Cleanup must work before the observer gets a chance to mark the notice inactive.
  await enforceTestRetention(1);
  expect(
    await queryAsOwner(
      'select id from app.workspace_inbox_threads where workspace_id=$1',
      [f.workspaceId],
      f.workspaceId,
    ),
  ).toEqual([]);
  await observer().observeCurrent?.();
  expect((await list()).items).toEqual([]);
});
