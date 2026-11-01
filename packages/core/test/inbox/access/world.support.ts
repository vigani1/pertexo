import {
  inbox,
  observer,
  queryAsOwner,
  seedFailure,
  seedNoticeWorkspace,
} from '../notices.fixture.js';

export async function workspaceWithThread() {
  const f = await seedNoticeWorkspace();
  await seedFailure(f.workspaceId, f.workflowId);
  await observer().foldPending(100);
  const read = inbox();
  const page = await read.listThreads({ ...f.scope, filter: 'all', limit: 10 });
  const thread = page.items[0];
  if (thread === undefined) throw new Error('Expected the failure notice');
  return { ...f, read, thread, listed: page };
}

export type World = Awaited<ReturnType<typeof workspaceWithThread>>;

export const setStatus = (f: World, status: 'suspended' | 'pending_deletion') =>
  queryAsOwner(
    status === 'suspended'
      ? "update app.workspaces set status='suspended' where id=$1"
      : `update app.workspaces set status='pending_deletion',
           deletion_requested_at=clock_timestamp(), deletion_requested_by=created_by,
           deletion_reason='Closing', purge_after=clock_timestamp()+interval '30 days'
         where id=$1`,
    [f.workspaceId],
    f.workspaceId,
  );
