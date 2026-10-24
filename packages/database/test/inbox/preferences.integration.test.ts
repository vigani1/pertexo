import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { NoticeConflictError } from '../../src/inbox/preferences/contract.js';
import { withTenantScopedClient } from '../../src/tenant-access/transactions.js';
import { updateMembership } from '../../src/tenant-access/members/records.repository.js';
import { apiUrl } from '../support/workflow-authoring.js';
import {
  preferences,
  inbox,
  observer,
  seedNoticeWorkspace,
  seedFailure,
  seedApproval,
  unhealthyConnection,
  queryAsOwner,
} from './notices.fixture.js';
const schedule = { mode: 'immediate' as const, hour: 9, timeZone: 'UTC' };
describe('personal notice preferences and audience fences', () => {
  it('uses Off inheritance, exact CAS receipts, and fresh authority before replay', async () => {
    const f = await seedNoticeWorkspace();
    const store = preferences();
    expect(await store.read(f.scope)).toMatchObject({
      revision: 0,
      mode: null,
      effective: { mode: 'off' },
      canManageDefaults: true,
    });
    const input = {
      ...f.scope,
      ...schedule,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    };
    expect(await store.replace(input)).toEqual({
      revision: 1,
      changed: true,
      replayed: false,
    });
    expect(await store.replace(input)).toEqual({
      revision: 1,
      changed: true,
      replayed: true,
    });
    await expect(
      store.replace({ ...input, idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(NoticeConflictError);
    await expect(
      store.replaceDefaults({
        ...input,
        actorId: f.members.builder,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ name: 'WorkspaceAccessDeniedError' });
    await queryAsOwner(
      "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
      [f.workspaceId, f.members.owner],
      f.workspaceId,
    );
    await expect(store.replace(input)).rejects.toMatchObject({
      name: 'WorkspaceAccessDeniedError',
    });
  });
  it('allows Off when mail is unavailable and refuses enabling it with a clear reason', async () => {
    const f = await seedNoticeWorkspace();
    const store = preferences(false);
    const unavailable = await store.read(f.scope);
    expect(unavailable.emailAvailable).toBe(false);
    expect(unavailable.emailUnavailableReason).toContain('durable system mail');
    await expect(
      store.replace({
        ...f.scope,
        ...schedule,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ name: 'NoticeUnavailableError' });
    expect(
      await store.replace({
        ...f.scope,
        ...schedule,
        mode: 'off',
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ revision: 1 });
  });
  it('adds a follower without granting capabilities, and mutes every workflow-associated notice privately', async () => {
    const f = await seedNoticeWorkspace();
    const store = preferences();
    const read = inbox();
    const fold = observer();
    await seedFailure(f.workspaceId, f.workflowId);
    await fold.foldPending(100);
    const viewer = { workspaceId: f.workspaceId, actorId: f.members.viewer };
    const subject = {
      subjectKind: 'workflow' as const,
      subjectId: f.workflowId,
    };
    expect(
      (await read.listThreads({ ...viewer, filter: 'all', limit: 100 })).items,
    ).toEqual([]);
    await store.replaceSubscription({
      ...viewer,
      ...subject,
      followed: true,
      muted: false,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    expect(
      (await read.listThreads({ ...viewer, filter: 'all', limit: 100 })).items,
    ).toHaveLength(1);
    expect(
      (await read.listThreads({ ...f.scope, filter: 'all', limit: 100 })).items,
    ).toHaveLength(1);
    await store.replaceSubscription({
      ...viewer,
      ...subject,
      followed: true,
      muted: true,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(
      (await read.listThreads({ ...viewer, filter: 'all', limit: 100 })).items,
    ).toEqual([]);
    expect(
      (await read.listThreads({ ...f.scope, filter: 'all', limit: 100 })).items,
    ).toHaveLength(1);
    const [{ role } = {}] = await queryAsOwner<{ role: string }>(
      'select role from app.workspace_memberships where workspace_id=$1 and user_id=$2',
      [f.workspaceId, f.members.viewer],
      f.workspaceId,
    );
    expect(role).toBe('viewer');
  });
  it('shows waiting approvals to the existing exact audience, including unlimited runs, and excludes the starter', async () => {
    const f = await seedNoticeWorkspace();
    const task = await seedApproval(f.workspaceId, f.workflowId, {
      starter: f.members.owner,
      named: f.members.viewer,
    });
    const fold = observer();
    const read = inbox();
    await queryAsOwner(
      'update app.pending_run_tasks set context=$2::jsonb where id=$1',
      [
        task.taskId,
        JSON.stringify({
          details: { Amount: 120, Customer: 'Captured customer' },
          prefill: {},
        }),
      ],
    );
    await Promise.all([fold.observeCurrent?.(), observer().observeCurrent?.()]);
    const owner = await read.listThreads({
      ...f.scope,
      filter: 'all',
      limit: 100,
    });
    expect(owner.items).toEqual([]);
    const visible = await read.listThreads({
      workspaceId: f.workspaceId,
      actorId: f.members.viewer,
      filter: 'all',
      limit: 100,
    });
    expect(visible.items).toMatchObject([
      {
        noticeKind: 'approval_waiting',
        subjectId: task.taskId,
        occurrenceCount: 1,
        details: { Amount: 120, Customer: 'Captured customer' },
      },
    ]);
    expect(
      (
        await read.listThreads({
          workspaceId: f.workspaceId,
          actorId: f.members.admin,
          filter: 'all',
          limit: 100,
        })
      ).items,
    ).toEqual([]);
    const before = visible.revision;
    await fold.observeCurrent?.();
    expect(
      (
        await read.readSummary({
          workspaceId: f.workspaceId,
          actorId: f.members.viewer,
        })
      ).revision,
    ).toBe(before);
    await queryAsOwner(
      "update app.pending_run_tasks set status='expired',completed_at=clock_timestamp() where workspace_id=$1 and id=$2",
      [f.workspaceId, task.taskId],
      f.workspaceId,
    );
    await fold.observeCurrent?.();
    expect(
      (
        await read.listThreads({
          workspaceId: f.workspaceId,
          actorId: f.members.viewer,
          filter: 'all',
          limit: 100,
        })
      ).items,
    ).toEqual([]);
  });
  it('observes actual failed connection tests once, resolves current attention, and respects owner/admin and private mute', async () => {
    const f = await seedNoticeWorkspace();
    const connectionId = await unhealthyConnection(
      f.workspaceId,
      f.members.owner,
    );
    const fold = observer();
    const read = inbox();
    const store = preferences();
    await Promise.all([fold.observeCurrent?.(), observer().observeCurrent?.()]);
    const list = () =>
      read.listThreads({ ...f.scope, filter: 'all', limit: 100 });
    expect((await list()).items).toMatchObject([
      {
        noticeKind: 'connection_attention',
        subjectId: connectionId,
        occurrenceCount: 1,
      },
    ]);
    expect(
      (
        await read.listThreads({
          workspaceId: f.workspaceId,
          actorId: f.members.operator,
          filter: 'all',
          limit: 100,
        })
      ).items,
    ).toEqual([]);
    await store.replaceSubscription({
      ...f.scope,
      subjectKind: 'connection',
      subjectId: connectionId,
      followed: false,
      muted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    expect((await list()).items).toEqual([]);
    const adminScope = { workspaceId: f.workspaceId, actorId: f.members.admin };
    expect(
      (await read.listThreads({ ...adminScope, filter: 'all', limit: 100 }))
        .items,
    ).toHaveLength(1);
    await queryAsOwner(
      "update app.connections set status='active',health_revision=health_revision+1 where workspace_id=$1 and id=$2",
      [f.workspaceId, connectionId],
      f.workspaceId,
    );
    await fold.observeCurrent?.();
    expect(
      (await read.listThreads({ ...adminScope, filter: 'all', limit: 100 }))
        .items,
    ).toEqual([]);
  });
  it('clears private membership state on removal, fences unsubscribe by incarnation, and isolates raw private reads', async () => {
    const f = await seedNoticeWorkspace();
    const store = preferences();
    const viewer = { workspaceId: f.workspaceId, actorId: f.members.viewer };
    await store.replace({
      ...viewer,
      ...schedule,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    await store.replaceSubscription({
      ...viewer,
      subjectKind: 'workflow',
      subjectId: f.workflowId,
      followed: true,
      muted: false,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const hidden = await withTenantScopedClient(pool, f.scope, (client) =>
        client.query(
          'select * from app.notice_preferences where workspace_id=$1 and user_id=$2',
          [f.workspaceId, f.members.viewer],
        ),
      );
      expect(hidden.rows).toEqual([]);
      await withTenantScopedClient(pool, f.scope, (client) =>
        updateMembership(client, f.workspaceId, {
          userId: f.members.viewer,
          role: 'viewer',
          status: 'removed',
          roleRevision: 2,
        }),
      );
      expect(
        await queryAsOwner(
          'select user_id from app.notice_preferences where workspace_id=$1 and user_id=$2',
          [f.workspaceId, f.members.viewer],
          f.workspaceId,
        ),
      ).toEqual([]);
      expect(
        await queryAsOwner(
          'select user_id from app.notice_subscriptions where workspace_id=$1 and user_id=$2',
          [f.workspaceId, f.members.viewer],
          f.workspaceId,
        ),
      ).toEqual([]);
      await queryAsOwner(
        "update app.workspace_memberships set status='active',role_revision=3 where workspace_id=$1 and user_id=$2",
        [f.workspaceId, f.members.viewer],
        f.workspaceId,
      );
      await store.replace({
        ...viewer,
        ...schedule,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
      expect(
        await store.unsubscribe({ ...viewer, revision: 1, memberRevision: 1 }),
      ).toBe(false);
      expect(
        await store.unsubscribe({ ...viewer, revision: 1, memberRevision: 3 }),
      ).toBe(true);
      expect(
        await store.unsubscribe({ ...viewer, revision: 1, memberRevision: 3 }),
      ).toBe(true);
      await store.replace({
        ...viewer,
        ...schedule,
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
      });
      expect(
        await store.unsubscribe({ ...viewer, revision: 1, memberRevision: 3 }),
      ).toBe(false);
    } finally {
      await pool.end();
    }
  });
});
