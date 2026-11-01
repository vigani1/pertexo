import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { createWorkflowFolderDatabase } from '../../../src/authoring/organization/folders/commands.repository.js';
import { NoticeUnavailableError } from '../../../src/inbox/preferences/contract.js';
import { adminDatabaseUrl } from '../../support/workflow-authoring/base.js';
import {
  config,
  inbox,
  own,
  preferences,
  queryAsOwner,
  seedNoticeWorkspace,
} from '../notices.fixture.js';
import { setStatus, workspaceWithThread, type World } from './world.support.js';

const EMPTY_PAGE = { items: [], next: null, revision: '0' };
const NO_SUMMARY = { unreadCount: 0, revision: '0' };
const DENIED = { name: 'WorkspaceAccessDeniedError' };

/** Everything the store answers someone with no access: values, never an error. */
async function expectEmptyInbox(
  f: World,
  actor: Readonly<{ workspaceId: string; actorId: string }>,
) {
  expect(
    await f.read.listThreads({ ...actor, filter: 'all', limit: 10 }),
  ).toEqual(EMPTY_PAGE);
  expect(await f.read.readSummary(actor)).toEqual(NO_SUMMARY);
  expect(
    await f.read.markThreadRead({
      ...actor,
      threadId: f.thread.id,
      revision: f.thread.revision,
    }),
  ).toBeUndefined();
  expect(
    await f.read.markAllRead({ ...actor, revision: f.thread.revision }),
  ).toEqual({ marked: 0 });
}

describe('someone who can no longer see the workspace', () => {
  it.each<[string, (f: World, actorId: string) => Promise<unknown>]>([
    [
      'have been removed',
      (f, actorId) =>
        queryAsOwner(
          "update app.workspace_memberships set status='removed',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
          [f.workspaceId, actorId],
          f.workspaceId,
        ),
    ],
    [
      'have a suspended membership',
      (f, actorId) =>
        queryAsOwner(
          "update app.workspace_memberships set status='suspended',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
          [f.workspaceId, actorId],
          f.workspaceId,
        ),
    ],
    [
      'have been suspended as a user',
      (_f, actorId) =>
        queryAsOwner("update app.users set status='suspended' where id=$1", [
          actorId,
        ]),
    ],
  ])('gets an empty Inbox when they %s', async (_how, leave) => {
    const f = await workspaceWithThread();
    const actor = { workspaceId: f.workspaceId, actorId: f.members.operator };
    expect((await f.read.readSummary(actor)).unreadCount).toBe(1);

    await leave(f, f.members.operator);

    await expectEmptyInbox(f, actor);
    await expect(preferences().read(actor)).rejects.toMatchObject(DENIED);
    expect((await f.read.readSummary(f.scope)).unreadCount).toBe(1);
  });

  it('gives a stranger the same empty Inbox', async () => {
    const f = await workspaceWithThread();
    const stranger = await seedNoticeWorkspace();

    await expectEmptyInbox(f, {
      workspaceId: f.workspaceId,
      actorId: stranger.members.owner,
    });
  });
});

describe('a workspace that is not active', () => {
  it('still shows a suspended workspace its threads, and changes nothing', async () => {
    const f = await workspaceWithThread();
    await setStatus(f, 'suspended');

    expect(
      await f.read.listThreads({ ...f.scope, filter: 'all', limit: 10 }),
    ).toEqual(f.listed);
    expect(await f.read.readSummary(f.scope)).toEqual({
      unreadCount: 1,
      revision: f.thread.revision,
    });
    expect(
      await f.read.markThreadRead({
        ...f.scope,
        threadId: f.thread.id,
        revision: f.thread.revision,
      }),
    ).toBeUndefined();
    expect(
      await f.read.markAllRead({ ...f.scope, revision: f.thread.revision }),
    ).toEqual({ marked: 0 });
    expect((await f.read.readSummary(f.scope)).unreadCount).toBe(1);
  });

  it('shows a workspace being deleted nothing at all', async () => {
    const f = await workspaceWithThread();
    await setStatus(f, 'pending_deletion');

    await expectEmptyInbox(f, f.scope);
  });
});

describe('a workflow in a folder the reader has no grant for', () => {
  async function restricted() {
    const f = await workspaceWithThread();
    const folders = own(createWorkflowFolderDatabase(config()));
    const { folder } = await folders.createFolder({
      ...f.scope,
      name: 'Reviewed access',
      parentId: null,
      idempotencyKey: randomUUID(),
    });
    await folders.placeWorkflow({
      ...f.scope,
      workflowId: f.workflowId,
      folderId: folder.id,
      expectedOrganizationRevision: 1,
      idempotencyKey: randomUUID(),
    });
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
    return {
      ...f,
      operator: { workspaceId: f.workspaceId, actorId: f.members.operator },
    };
  }

  it('keeps its thread out of the list, the summary and both marks', async () => {
    const f = await restricted();

    expect(
      (await f.read.listThreads({ ...f.operator, filter: 'all', limit: 10 }))
        .items,
    ).toEqual([]);
    expect((await f.read.readSummary(f.operator)).unreadCount).toBe(0);
    expect(
      await f.read.markThreadRead({
        ...f.operator,
        threadId: f.thread.id,
        revision: f.thread.revision,
      }),
    ).toBeUndefined();
    expect(
      await f.read.markAllRead({ ...f.operator, revision: f.thread.revision }),
    ).toEqual({ marked: 0 });
  });

  it('calls its subscription unavailable, on a suspended workspace too', async () => {
    const f = await restricted();
    const store = preferences();
    const subject = {
      ...f.operator,
      subjectKind: 'workflow' as const,
      subjectId: f.workflowId,
    };
    const replace = () =>
      store.replaceSubscription({
        ...subject,
        followed: true,
        muted: false,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
    await expect(store.readSubscription(subject)).rejects.toBeInstanceOf(
      NoticeUnavailableError,
    );
    await expect(replace()).rejects.toBeInstanceOf(NoticeUnavailableError);

    await setStatus(f, 'suspended');

    await expect(store.readSubscription(subject)).rejects.toBeInstanceOf(
      NoticeUnavailableError,
    );
  });
});

describe('the reader', () => {
  it('gives up on a statement after 2 seconds', async () => {
    const f = await seedNoticeWorkspace();
    const read = inbox();
    const admin = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
    const blocker = await admin.connect();
    try {
      await blocker.query('begin');
      await blocker.query(
        'lock table app.workspace_inbox_threads in access exclusive mode',
      );
      const started = performance.now();
      const answer = await read
        .readSummary(f.scope)
        .then(() => 'answered')
        .catch((error: unknown) => error);
      const waited = performance.now() - started;

      expect(answer).toBeInstanceOf(Error);
      expect(waited).toBeGreaterThan(1_500);
      expect(waited).toBeLessThan(4_000);
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await admin.end();
    }
    expect((await read.readSummary(f.scope)).unreadCount).toBe(0);
  });
});

describe('the fold function', () => {
  it.each([
    ['no window', null],
    ['a zero window', '0 hours'],
    ['a negative window', '-1 hours'],
  ])('refuses %s', async (_case, window) => {
    await expect(
      queryAsOwner(
        'select * from app.fold_workspace_inbox_events(10,$1::interval)',
        [window],
      ),
    ).rejects.toMatchObject({ code: '22023' });
  });
});
