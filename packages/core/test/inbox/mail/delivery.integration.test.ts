import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSystemMailDeliveryStore } from '@pertexo/database/platform';
import type { NoticeMailToSeal } from '../../../src/inbox/mail/contract.js';
import { purgeTestWorkspace } from '../../support/workflow-authoring.js';
import {
  config,
  preferences,
  mail,
  observer,
  own,
  seedNoticeWorkspace,
  seedNoticeWorkflow,
  seedFailure,
  queryAsOwner,
} from '../notices.fixture.js';
const immediate = { mode: 'immediate' as const, hour: 9, timeZone: 'UTC' };
async function enable(scope: { workspaceId: string; actorId: string }) {
  return preferences().replace({
    ...scope,
    ...immediate,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
}
describe('durable personal notice batches', () => {
  it.each(['hourly', 'daily'] as const)(
    'persists the %s due time and coalesces downtime into one current batch',
    async (mode) => {
      const f = await seedNoticeWorkspace();
      await preferences().replace({
        ...f.scope,
        mode,
        hour: 9,
        timeZone: 'Europe/Paris',
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
      await seedFailure(f.workspaceId, f.workflowId);
      await observer().foldPending(100);
      const captured: NoticeMailToSeal[] = [];
      const first = mail(captured);
      // A future persisted boundary survives a new worker instance without an early send.
      await queryAsOwner(
        "update app.notice_preferences set next_due_at=clock_timestamp()+interval '1 hour' where workspace_id=$1 and user_id=$2",
        [f.workspaceId, f.members.owner],
        f.workspaceId,
      );
      await first.prepare();
      expect(
        captured.filter((item) => item.workspaceId === f.workspaceId),
      ).toHaveLength(0);
      await queryAsOwner(
        "update app.notice_preferences set next_due_at=clock_timestamp()-interval '5 days' where workspace_id=$1 and user_id=$2",
        [f.workspaceId, f.members.owner],
        f.workspaceId,
      );
      const restarted = mail(captured);
      await restarted.prepare();
      expect(
        captured.filter((item) => item.workspaceId === f.workspaceId),
      ).toHaveLength(1);
      await restarted.prepare();
      expect(
        captured.filter((item) => item.workspaceId === f.workspaceId),
      ).toHaveLength(1);
      const rows = await queryAsOwner<{ future: boolean; window_key: string }>(
        'select pref.next_due_at>clock_timestamp() future,batch.window_key from app.notice_preferences pref join app.notice_mail_batches batch on batch.workspace_id=pref.workspace_id and batch.user_id=pref.user_id where pref.workspace_id=$1 and pref.user_id=$2',
        [f.workspaceId, f.members.owner],
        f.workspaceId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.future).toBe(true);
      expect(rows[0]?.window_key).toMatch(new RegExp(`^${mode}:`, 'u'));
    },
  );
  it('prepares one batch across workers, witnesses every thread, and rechecks every subject before dispatch', async () => {
    const f = await seedNoticeWorkspace();
    await enable(f.scope);
    const second = await seedNoticeWorkflow(f.workspaceId, f.members.owner);
    await seedFailure(f.workspaceId, f.workflowId);
    await seedFailure(f.workspaceId, second);
    await observer().foldPending(100);
    const captured: NoticeMailToSeal[] = [];
    const first = mail(captured),
      other = mail(captured);
    expect(
      (await Promise.all([first.prepare(), other.prepare()])).reduce(
        (a, b) => a + b,
        0,
      ),
    ).toBe(1);
    expect(captured).toHaveLength(1);
    const sealed = captured[0];
    if (sealed === undefined) throw new Error('Expected prepared mail');
    expect(sealed.items).toHaveLength(2);
    expect(sealed.workspaceName).toBe('Notice proof');
    expect(sealed.toEmail).toContain('@example.test');
    expect(await first.authorize(sealed.id)).toBe(true);
    await preferences().replaceSubscription({
      ...f.scope,
      subjectKind: 'workflow',
      subjectId: second,
      followed: false,
      muted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    expect(await first.authorize(sealed.id)).toBe(false);
    const delivery = own(createSystemMailDeliveryStore(config()));
    const claims = await delivery.claim({
      workerId: 'notice-proof',
      limit: 50,
    });
    const claim = claims.find((item) => item.id === sealed.id);
    if (claim === undefined) throw new Error('Expected delivery claim');
    expect(claim.id).toBe(sealed.id);
    await delivery.settle({
      id: claim.id,
      leaseToken: claim.leaseToken,
      leaseGeneration: claim.leaseGeneration,
      outcome: 'failed',
      failureCode: 'notice.superseded',
    });
    await queryAsOwner(
      'update app.notice_preferences set next_due_at=clock_timestamp() where workspace_id=$1 and user_id=$2',
      [f.workspaceId, f.members.owner],
      f.workspaceId,
    );
    expect(await first.prepare()).toBe(1);
    expect(captured.at(-1)?.items.map((item) => item.workflowId)).toEqual([
      f.workflowId,
    ]);
    const batches = await queryAsOwner<{ released_at: Date | null }>(
      'select released_at from app.notice_mail_batches where workspace_id=$1 order by created_at',
      [f.workspaceId],
      f.workspaceId,
    );
    expect(batches).toHaveLength(2);
    expect(batches[0]?.released_at).toBeInstanceOf(Date);
  });
  it('does not cover changes with a global revision or starve a followed subject behind ineligible threads', async () => {
    const f = await seedNoticeWorkspace();
    const viewer = { workspaceId: f.workspaceId, actorId: f.members.viewer };
    await enable(viewer);
    for (let i = 0; i < 105; i++) {
      const workflow = await seedNoticeWorkflow(f.workspaceId, f.members.owner);
      await seedFailure(f.workspaceId, workflow);
    }
    await seedFailure(f.workspaceId, f.workflowId);
    const fold = observer();
    await fold.foldPending(1000);
    await preferences().replaceSubscription({
      ...viewer,
      subjectKind: 'workflow',
      subjectId: f.workflowId,
      followed: true,
      muted: false,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    // Enabling a follow does not email its history; a later failure qualifies.
    await seedFailure(f.workspaceId, f.workflowId);
    await fold.foldPending(1000);
    const captured: NoticeMailToSeal[] = [];
    const store = mail(captured);
    expect(await store.prepare()).toBe(1);
    expect(captured[0]?.items.map((item) => item.workflowId)).toEqual([
      f.workflowId,
    ]);
    expect(
      await queryAsOwner(
        'select id from app.notice_mail_batches where workspace_id=$1',
        [f.workspaceId],
        f.workspaceId,
      ),
    ).toHaveLength(1);
  });
  it('witnesses at most 100 changed subjects and leaves the rest for a later window', async () => {
    const f = await seedNoticeWorkspace();
    await enable(f.scope);
    for (let index = 0; index < 101; index++) {
      const workflowId = await seedNoticeWorkflow(
        f.workspaceId,
        f.members.owner,
      );
      await seedFailure(f.workspaceId, workflowId);
    }
    await observer().foldPending(1000);
    const captured: NoticeMailToSeal[] = [];
    const store = mail(captured);
    await store.prepare();
    const batch = captured.find((item) => item.workspaceId === f.workspaceId);
    if (batch === undefined) throw new Error('Expected bounded notice batch');
    expect(batch.items).toHaveLength(100);
    expect(new Set(batch.items.map((item) => item.id)).size).toBe(100);
    const deliveries = own(createSystemMailDeliveryStore(config()));
    const claims = await deliveries.claim({
      workerId: 'bounded-mail',
      limit: 50,
    });
    const claim = claims.find((item) => item.id === batch.id);
    if (claim === undefined) throw new Error('Expected bounded delivery claim');
    await deliveries.settle({
      id: claim.id,
      leaseToken: claim.leaseToken,
      leaseGeneration: claim.leaseGeneration,
      outcome: 'submitted',
    });
    // Expire only the prior scheduling window, keeping every per-thread witness intact.
    await queryAsOwner(
      "update app.notice_mail_batches set window_key='immediate:prior-window' where workspace_id=$1 and user_id=$2",
      [f.workspaceId, f.members.owner],
      f.workspaceId,
    );
    await queryAsOwner(
      'update app.notice_preferences set next_due_at=clock_timestamp() where workspace_id=$1 and user_id=$2',
      [f.workspaceId, f.members.owner],
      f.workspaceId,
    );
    await store.prepare();
    const batches = captured.filter(
      (item) => item.workspaceId === f.workspaceId,
    );
    expect(batches.map((item) => item.items.length)).toEqual([100, 1]);
    expect(
      batches[1]?.items.every(
        (item) => !batch.items.some((previous) => previous.id === item.id),
      ),
    ).toBe(true);
  });
  it('binds queued content to verified email, member revision, personal and inherited default choices', async () => {
    const f = await seedNoticeWorkspace();
    const settings = preferences();
    await settings.replaceDefaults({
      ...f.scope,
      ...immediate,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    await seedFailure(f.workspaceId, f.workflowId);
    await observer().foldPending(100);
    const captured: NoticeMailToSeal[] = [];
    const store = mail(captured);
    expect(await store.prepare()).toBeGreaterThan(0);
    const batch = captured.find((item) => item.actorId === f.members.owner);
    if (batch === undefined) throw new Error('Expected inherited owner mail');
    expect(await store.authorize(batch.id)).toBe(true);
    await queryAsOwner(
      'update app.users set email_verified=false where id=$1',
      [f.members.owner],
    );
    expect(await store.authorize(batch.id)).toBe(false);
    await queryAsOwner('update app.users set email_verified=true where id=$1', [
      f.members.owner,
    ]);
    await queryAsOwner(
      'update app.workspace_memberships set role_revision=role_revision+1 where workspace_id=$1 and user_id=$2',
      [f.workspaceId, f.members.owner],
      f.workspaceId,
    );
    expect(await store.authorize(batch.id)).toBe(false);
    const g = await seedNoticeWorkspace();
    await enable(g.scope);
    await seedFailure(g.workspaceId, g.workflowId);
    await observer().foldPending(100);
    const other: NoticeMailToSeal[] = [];
    const second = mail(other);
    await second.prepare();
    const ownBatch = other.find((item) => item.actorId === g.members.owner);
    if (ownBatch === undefined) throw new Error('Expected explicit mail');
    expect(await second.authorize(ownBatch.id)).toBe(true);
    await settings.replace({
      ...g.scope,
      ...immediate,
      mode: 'off',
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(await second.authorize(ownBatch.id)).toBe(false);
  });
  it('keeps possibly delivered SMTP outcomes covered and gives security mail claim priority', async () => {
    const f = await seedNoticeWorkspace();
    await enable(f.scope);
    await seedFailure(f.workspaceId, f.workflowId);
    await observer().foldPending(100);
    const captured: NoticeMailToSeal[] = [];
    const store = mail(captured);
    await store.prepare();
    const notice = captured.find((item) => item.actorId === f.members.owner);
    if (notice === undefined) throw new Error('Expected notice');
    const authenticationId = randomUUID();
    await queryAsOwner(
      "insert into app.system_mail_deliveries(id,purpose,expires_at,payload_ciphertext,payload_nonce,payload_tag,payload_key_version) values($1,'verification',clock_timestamp()+interval '1 hour','cipher','nonce','tag','v1')",
      [authenticationId],
    );
    const deliveries = own(createSystemMailDeliveryStore(config()));
    const claims = await deliveries.claim({
      workerId: 'security-priority',
      limit: 50,
    });
    expect(claims[0]?.id).toBe(authenticationId);
    const pending = claims.find((claim) => claim.id === notice.id);
    if (pending === undefined) throw new Error('Expected claimed notice');
    await deliveries.settle({
      id: pending.id,
      leaseToken: pending.leaseToken,
      leaseGeneration: pending.leaseGeneration,
      outcome: 'reconciliation_required',
      failureCode: 'delivery.outcome_unknown',
    });
    await queryAsOwner(
      'update app.notice_preferences set next_due_at=clock_timestamp() where workspace_id=$1 and user_id=$2',
      [f.workspaceId, f.members.owner],
      f.workspaceId,
    );
    expect(await store.prepare()).toBe(0);
    expect(
      await queryAsOwner(
        'select id from app.notice_mail_batches where workspace_id=$1',
        [f.workspaceId],
        f.workspaceId,
      ),
    ).toHaveLength(1);
  });
  it('purges sealed personal mail before its workspace membership and private state', async () => {
    const f = await seedNoticeWorkspace();
    await enable(f.scope);
    await preferences().replaceSubscription({
      ...f.scope,
      subjectKind: 'workflow',
      subjectId: f.workflowId,
      followed: true,
      muted: false,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    await seedFailure(f.workspaceId, f.workflowId);
    await observer().foldPending(100);
    const captured: NoticeMailToSeal[] = [];
    const store = mail(captured);
    await store.prepare();
    const batch = captured.find((item) => item.workspaceId === f.workspaceId);
    if (batch === undefined)
      throw new Error('Expected personal mail before purge');
    expect(await store.authorize(batch.id)).toBe(true);
    const steps = await purgeTestWorkspace(f.workspaceId);
    expect(steps).toContain('personal_notice_mail');
    expect(
      await queryAsOwner(
        'select id from app.system_mail_deliveries where id=$1',
        [batch.id],
      ),
    ).toHaveLength(0);
    for (const table of [
      'notice_mail_items',
      'notice_mail_batches',
      'notice_subscriptions',
      'notice_preferences',
      'workspace_inbox_threads',
    ]) {
      expect(
        await queryAsOwner(
          `select workspace_id from app.${table} where workspace_id=$1`,
          [f.workspaceId],
          f.workspaceId,
        ),
      ).toHaveLength(0);
    }
    expect(await store.authorize(batch.id)).toBe(false);
  });
});
