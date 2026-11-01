import { createConnectionDatabase } from '../../src/connections/repository.js';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createWorkflowFolderDatabase } from '../../src/authoring/organization/folders/commands.repository.js';
import { createPendingTaskStore } from '../../src/runs/pending-tasks/responses/repository.js';
import { PendingTaskNotFoundError } from '../../src/runs/pending-tasks/responses/errors.js';
import type { NoticeMailToSeal } from '../../src/inbox/mail/contract.js';
import {
  own,
  config,
  preferences,
  inbox,
  observer,
  mail,
  unhealthyConnection,
  seedNoticeWorkspace,
  seedFailure,
  seedApproval,
} from './notices.fixture.js';

it('revokes followed notices, waiting approvals and already prepared mail through the same current folder scope', async () => {
  const f = await seedNoticeWorkspace();
  const scope = { workspaceId: f.workspaceId, actorId: f.members.viewer };
  const folders = own(createWorkflowFolderDatabase(config()));
  const folder = (
    await folders.createFolder({
      ...f.scope,
      name: 'Reviewed access',
      parentId: null,
      idempotencyKey: randomUUID(),
    })
  ).folder;
  await folders.placeWorkflow({
    ...f.scope,
    workflowId: f.workflowId,
    folderId: folder.id,
    expectedOrganizationRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await preferences().replaceSubscription({
    ...scope,
    subjectKind: 'workflow',
    subjectId: f.workflowId,
    followed: true,
    muted: false,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  await preferences().replace({
    ...scope,
    mode: 'immediate',
    hour: 9,
    timeZone: 'UTC',
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  await seedFailure(f.workspaceId, f.workflowId);
  const { taskId } = await seedApproval(f.workspaceId, f.workflowId, {
    starter: f.members.owner,
    named: scope.actorId,
  });
  const fold = observer();
  await fold.foldPending(100);
  await fold.observeCurrent?.();
  const read = inbox();
  const before = await read.listThreads({ ...scope, filter: 'all', limit: 50 });
  expect(before.items.map((item) => item.noticeKind)).toEqual(
    expect.arrayContaining(['workflow_failure', 'approval_waiting']),
  );
  const tasks = own(createPendingTaskStore(config()));
  expect((await tasks.read({ ...scope, taskId })).canRespond).toBe(true);
  const captured: NoticeMailToSeal[] = [];
  const delivery = mail(captured);
  await delivery.prepare();
  const sealed = captured.find(
    (item) =>
      item.workspaceId === f.workspaceId && item.actorId === scope.actorId,
  );
  if (!sealed) throw new Error('Expected prepared viewer mail');
  expect(await delivery.authorize(sealed.id)).toBe(true);
  await folders.replaceSharing({
    ...f.scope,
    folderId: folder.id,
    idempotencyKey: randomUUID(),
    request: {
      mode: 'restricted',
      grants: [],
      expectedFolderRevision: folder.revision,
    },
  });
  expect(
    (await read.listThreads({ ...scope, filter: 'all', limit: 1 })).items,
  ).toEqual([]);
  expect(await read.readSummary(scope)).toEqual({
    unreadCount: 0,
    revision: '0',
  });
  expect(
    (await tasks.list({ ...scope, view: 'mine', status: 'pending' })).items,
  ).toEqual([]);
  await expect(tasks.read({ ...scope, taskId })).rejects.toBeInstanceOf(
    PendingTaskNotFoundError,
  );
  await expect(
    tasks.decide({
      ...scope,
      taskId,
      decision: 'approved',
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toBeInstanceOf(PendingTaskNotFoundError);
  expect(await delivery.authorize(sealed.id)).toBe(false);
  expect(
    (await read.listThreads({ ...f.scope, filter: 'all', limit: 50 })).items
      .length,
  ).toBeGreaterThan(0);
});

it('keeps restricted connection health notices confined to administrators', async () => {
  const f = await seedNoticeWorkspace();
  const connectionId = await unhealthyConnection(
    f.workspaceId,
    f.members.owner,
  );
  const scope = { workspaceId: f.workspaceId, actorId: f.members.viewer };
  await observer().observeCurrent?.();
  const read = inbox();
  expect(
    (await read.listThreads({ ...scope, filter: 'all', limit: 1 })).items,
  ).toEqual([]);
  expect(
    (await read.listThreads({ ...f.scope, filter: 'all', limit: 1 })).items,
  ).toHaveLength(1);
  const connections = own(createConnectionDatabase(config()));
  await connections.replaceConnectionSharing({
    ...f.scope,
    connectionId,
    idempotencyKey: randomUUID(),
    request: { mode: 'restricted', expectedSharingRevision: 1, userIds: [] },
  });
  expect(
    (await read.listThreads({ ...scope, filter: 'all', limit: 1 })).items,
  ).toEqual([]);
  expect(
    (await read.listThreads({ ...f.scope, filter: 'all', limit: 1 })).items,
  ).toHaveLength(1);
  expect(await read.readSummary(scope)).toEqual({
    unreadCount: 0,
    revision: '0',
  });
});
