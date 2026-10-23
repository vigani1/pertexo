import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { identity } from '../support/workflow-authoring.js';
import {
  inbox,
  observer,
  preferences,
  queryAsOwner,
  seedFailure,
  seedNoticeWorkspace,
} from './notices.fixture.js';

it.each(['removed', 'left'] as const)(
  'does not restore private notices when a member who %s rejoins',
  async (departure) => {
    const workspace = await seedNoticeWorkspace();
    const other = await seedNoticeWorkspace();
    const actorId = workspace.members.builder;
    const scope = { workspaceId: workspace.workspaceId, actorId };
    const otherScope = { workspaceId: other.workspaceId, actorId };
    await queryAsOwner(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active')",
      [other.workspaceId, actorId],
      other.workspaceId,
    );
    const store = preferences();
    for (const target of [scope, otherScope]) {
      await store.replace({
        ...target,
        mode: 'immediate',
        hour: 9,
        timeZone: 'UTC',
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
    }
    const subject = {
      ...scope,
      subjectKind: 'workflow' as const,
      subjectId: workspace.workflowId,
    };
    await store.replaceSubscription({
      ...subject,
      followed: true,
      muted: false,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    await seedFailure(workspace.workspaceId, workspace.workflowId);
    await observer().foldPending(100);
    const read = inbox();
    const page = await read.listThreads({ ...scope, filter: 'all', limit: 10 });
    const thread = page.items[0];
    if (thread === undefined) throw new Error('Expected followed failure');
    await read.markThreadRead({
      ...scope,
      threadId: thread.id,
      revision: thread.revision,
    });
    expect((await read.readSummary(scope)).unreadCount).toBe(0);

    if (departure === 'left') {
      await identity.leaveWorkspace({
        workspaceId: scope.workspaceId,
        actorUserId: actorId,
        idempotencyKey: randomUUID(),
      });
    } else {
      await identity.removeWorkspaceMember({
        workspaceId: scope.workspaceId,
        actorUserId: workspace.members.owner,
        targetUserId: actorId,
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });
    }
    await expect(store.read(scope)).rejects.toMatchObject({
      name: 'WorkspaceAccessDeniedError',
    });
    // Rejoin is fixture setup; assertions use the public preference/inbox reads.
    await queryAsOwner(
      "update app.workspace_memberships set status='active',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
      [scope.workspaceId, actorId],
      scope.workspaceId,
    );
    expect(await store.read(scope)).toMatchObject({ revision: 0, mode: null });
    expect(await store.readSubscription(subject)).toMatchObject({
      revision: 0,
      followed: false,
      muted: false,
    });
    expect(await store.read(otherScope)).toMatchObject({
      revision: 1,
      mode: 'immediate',
    });
    await store.replaceSubscription({
      ...subject,
      followed: true,
      muted: false,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    expect((await read.readSummary(scope)).unreadCount).toBe(1);
  },
);
