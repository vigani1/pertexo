import { expect, it } from 'vitest';
import {
  inbox,
  observer,
  queryAsOwner,
  seedFailure,
  seedNoticeWorkspace,
} from './notices.fixture.js';

// ADR 013/027: a suspended workspace reads but does not change, and that holds
// under row security too, not only at the route.
it('shows the notices of a suspended workspace without recording anything', async () => {
  const workspace = await seedNoticeWorkspace();
  const scope = {
    workspaceId: workspace.workspaceId,
    actorId: workspace.members.owner,
  };
  await seedFailure(workspace.workspaceId, workspace.workflowId);
  await observer().foldPending(100);
  await queryAsOwner(
    "update app.workspaces set status='suspended' where id=$1",
    [workspace.workspaceId],
    workspace.workspaceId,
  );

  const read = inbox();
  const page = await read.listThreads({ ...scope, filter: 'all', limit: 10 });
  const thread = page.items[0];
  if (thread === undefined) throw new Error('Expected the failure notice');
  expect((await read.readSummary(scope)).unreadCount).toBe(1);

  await read
    .markThreadRead({
      ...scope,
      threadId: thread.id,
      revision: thread.revision,
    })
    .catch(() => undefined);
  expect((await read.readSummary(scope)).unreadCount).toBe(1);
});

it('keeps the notices of a workspace being deleted out of reach', async () => {
  const workspace = await seedNoticeWorkspace();
  const scope = {
    workspaceId: workspace.workspaceId,
    actorId: workspace.members.owner,
  };
  await seedFailure(workspace.workspaceId, workspace.workflowId);
  await observer().foldPending(100);
  await queryAsOwner(
    `update app.workspaces set status='pending_deletion',
       deletion_requested_at=clock_timestamp(), deletion_requested_by=created_by,
       deletion_reason='Closing', purge_after=clock_timestamp()+interval '30 days'
     where id=$1`,
    [workspace.workspaceId],
    workspace.workspaceId,
  );

  const page = await inbox().listThreads({
    ...scope,
    filter: 'all',
    limit: 10,
  });
  expect(page.items).toEqual([]);
});
