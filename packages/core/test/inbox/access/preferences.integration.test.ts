import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  NoticeConflictError,
  NoticeUnavailableError,
} from '../../../src/inbox/preferences/contract.js';
import {
  observer,
  preferences,
  seedFailure,
  seedNoticeWorkspace,
  unhealthyConnection,
} from '../notices.fixture.js';
import { setStatus, workspaceWithThread } from './world.support.js';

const DENIED = { name: 'WorkspaceAccessDeniedError' };
const schedule = { mode: 'immediate' as const, hour: 9, timeZone: 'UTC' };

describe('preferences on a workspace that is not active', () => {
  it('lets preferences be read but not changed while suspended', async () => {
    const f = await workspaceWithThread();
    const store = preferences();
    const subject = {
      ...f.scope,
      subjectKind: 'workflow' as const,
      subjectId: f.workflowId,
    };
    await store.replace({
      ...f.scope,
      ...schedule,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    await setStatus(f, 'suspended');

    expect(await store.read(f.scope)).toMatchObject({
      revision: 1,
      mode: 'immediate',
    });
    expect(await store.readSubscription(subject)).toEqual({
      revision: 0,
      followed: false,
      muted: false,
    });
    await expect(
      store.replace({
        ...f.scope,
        ...schedule,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject(DENIED);
    await expect(
      store.replaceDefaults({
        ...f.scope,
        ...schedule,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject(DENIED);
    await expect(
      store.replaceSubscription({
        ...subject,
        followed: true,
        muted: false,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject(DENIED);
    await expect(
      store.unsubscribe({ ...f.scope, revision: 1, memberRevision: 1 }),
    ).rejects.toMatchObject(DENIED);
    expect(await store.read(f.scope)).toMatchObject({ revision: 1 });
  });

  it('refuses every preference read and change while being deleted', async () => {
    const f = await workspaceWithThread();
    const store = preferences();
    await setStatus(f, 'pending_deletion');

    await expect(store.read(f.scope)).rejects.toMatchObject(DENIED);
    await expect(
      store.readSubscription({
        ...f.scope,
        subjectKind: 'workflow',
        subjectId: f.workflowId,
      }),
    ).rejects.toMatchObject(DENIED);
  });
});

describe('preference rules', () => {
  it('lets a viewer read and set their own, but not the defaults', async () => {
    const f = await seedNoticeWorkspace();
    const store = preferences();
    const viewer = { workspaceId: f.workspaceId, actorId: f.members.viewer };

    expect(await store.read(viewer)).toMatchObject({
      canManageDefaults: false,
    });
    expect(
      await store.replace({
        ...viewer,
        ...schedule,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      }),
    ).toEqual({ revision: 1, changed: true, replayed: false });
    await expect(
      store.replaceDefaults({
        ...viewer,
        ...schedule,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject(DENIED);
  });

  it('refuses following a connection, and replays or rejects by revision', async () => {
    const f = await seedNoticeWorkspace();
    const store = preferences();
    const connectionId = await unhealthyConnection(
      f.workspaceId,
      f.members.owner,
    );
    await expect(
      store.replaceSubscription({
        ...f.scope,
        subjectKind: 'connection',
        subjectId: connectionId,
        followed: true,
        muted: false,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(NoticeUnavailableError);

    const mute = {
      ...f.scope,
      subjectKind: 'connection' as const,
      subjectId: connectionId,
      followed: false,
      muted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    };
    expect(await store.replaceSubscription(mute)).toEqual({
      revision: 1,
      changed: true,
      replayed: false,
    });
    expect(await store.replaceSubscription(mute)).toEqual({
      revision: 1,
      changed: true,
      replayed: true,
    });
    await expect(
      store.replaceSubscription({ ...mute, idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(NoticeConflictError);
  });

  it('keeps a muted workflow out of the Inbox across new failures, until it is unmuted', async () => {
    const f = await workspaceWithThread();
    const operator = {
      workspaceId: f.workspaceId,
      actorId: f.members.operator,
    };
    const store = preferences();
    const subject = {
      ...operator,
      subjectKind: 'workflow' as const,
      subjectId: f.workflowId,
    };
    await store.replaceSubscription({
      ...subject,
      followed: false,
      muted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });

    await seedFailure(f.workspaceId, f.workflowId);
    await observer().foldPending(100);

    expect(await f.read.readSummary(operator)).toMatchObject({
      unreadCount: 0,
    });
    expect(
      (await f.read.listThreads({ ...operator, filter: 'all', limit: 10 }))
        .items,
    ).toEqual([]);
    expect(
      await f.read.markThreadRead({
        ...operator,
        threadId: f.thread.id,
        revision: f.thread.revision,
      }),
    ).toBeUndefined();

    await store.replaceSubscription({
      ...subject,
      followed: false,
      muted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(await f.read.readSummary(operator)).toMatchObject({
      unreadCount: 1,
    });
  });
});
