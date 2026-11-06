import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/primitives';
import { createFailureNotificationStore } from '../../../src/notifications/failure-notification.store.js';
import {
  asAdmin,
  asRuntime,
  databaseUrl,
  parseDatabaseConfig,
  workerBaseUrl,
  workspaceA,
} from '../../runs/run-store/run-store.fixture.js';
import {
  noticeFacts,
  seedNotice,
  seedNotificationDestination,
} from './notification-recovery.fixture.js';

const store = createFailureNotificationStore(
  parseDatabaseConfig({ connectionString: databaseUrl(workerBaseUrl), max: 4 }),
);
afterAll(() => store.close());
let other: Awaited<ReturnType<typeof seedNotificationDestination>>;
beforeAll(async () => {
  other = await seedNotificationDestination();
});

const cases = [
  {
    status: 'claimed',
    sideEffectClass: 'safe',
    attempts: 1,
    expected: 'retry',
    code: 'delivery.recovery_predispatch',
    uncertain: false,
  },
  {
    status: 'dispatching',
    sideEffectClass: 'safe',
    attempts: 1,
    expected: 'retry',
    code: 'delivery.recovery_ambiguous',
    uncertain: true,
  },
  {
    status: 'dispatching',
    sideEffectClass: 'unsafe',
    attempts: 1,
    expected: 'outcome_unknown',
    code: 'delivery.recovery_ambiguous',
    uncertain: true,
  },
  {
    status: 'claimed',
    sideEffectClass: 'unsafe',
    attempts: 3,
    expected: 'dead_letter',
    code: 'delivery.attempts_exhausted',
    uncertain: false,
  },
  {
    status: 'claimed',
    sideEffectClass: 'idempotent_with_key',
    attempts: 3,
    unresolved: true,
    expected: 'outcome_unknown',
    code: 'delivery.attempts_exhausted_unknown',
    uncertain: true,
  },
  {
    status: 'dispatching',
    sideEffectClass: 'idempotent_with_key',
    attempts: 3,
    expected: 'outcome_unknown',
    code: 'delivery.attempts_exhausted_unknown',
    uncertain: true,
  },
  {
    status: 'claimed',
    sideEffectClass: 'idempotent_with_key',
    attempts: 1,
    unresolved: true,
    expected: 'retry',
    code: 'delivery.recovery_predispatch',
    uncertain: true,
  },
  {
    status: 'dispatching',
    sideEffectClass: 'idempotent_with_key',
    attempts: 1,
    expected: 'retry',
    code: 'delivery.recovery_ambiguous',
    uncertain: true,
  },
  {
    status: 'dispatching',
    sideEffectClass: 'safe',
    attempts: 3,
    expected: 'dead_letter',
    code: 'delivery.attempts_exhausted',
    uncertain: true,
  },
  {
    status: 'claimed',
    sideEffectClass: 'idempotent_with_key',
    attempts: 3,
    expected: 'dead_letter',
    code: 'delivery.attempts_exhausted',
    uncertain: false,
  },
] as const;

describe('failure notification recovery owned by core', () => {
  it.each(cases)(
    'recovers $status $sideEffectClass attempt $attempts with its persisted delivery truth',
    async (scenario) => {
      const notice = await seedNotice(scenario);
      expect(await store.recoverDue(100, 3)).toBe(1);
      const facts = await noticeFacts(notice.id),
        retry = scenario.expected === 'retry';
      expect(facts.intent).toEqual({
        status: scenario.expected,
        safe_error_code: scenario.code,
        possibly_dispatched: scenario.uncertain,
        delivery_attempts: scenario.attempts,
        dispatch_cleared: true,
        recovery_cleared: true,
        retry_due: retry,
        completed: !retry,
      });
      const factType = {
        retry: 'retry_scheduled',
        outcome_unknown: 'outcome_unknown',
        dead_letter: 'dead_lettered',
      }[scenario.expected];
      expect(facts.audit).toEqual([
        {
          fact_type: factType,
          attempt_number: scenario.attempts,
          safe_error_code: scenario.code,
          possibly_dispatched: scenario.uncertain,
        },
      ]);
      expect(facts.outbox).toHaveLength(retry ? 1 : 0);
      for (const event of facts.outbox) {
        expect(event.payload).toEqual({
          workspaceId: notice.workspaceId,
          notificationIntentId: notice.id,
          outboxEventId: event.id,
        });
        expect(event.payload_checksum).toBe(
          canonicalOutboxPayloadChecksum(event.payload),
        );
      }
      expect(await store.recoverDue(100, 3)).toBe(0);
      expect(await noticeFacts(notice.id)).toEqual(facts);
    },
  );

  it('recovers two workspaces concurrently once per intent and leaves a future recovery alone', async () => {
    const a = await seedNotice({
      status: 'claimed',
      sideEffectClass: 'idempotent_with_key',
      attempts: 1,
    });
    const b = await seedNotice(
      {
        status: 'claimed',
        sideEffectClass: 'idempotent_with_key',
        attempts: 1,
      },
      other,
    );
    const future = await seedNotice({
      status: 'claimed',
      sideEffectClass: 'idempotent_with_key',
      attempts: 1,
    });
    await asAdmin((client) =>
      client.query(
        "update app.run_failure_notification_intents set recovery_at=clock_timestamp()+interval '1 hour' where id=$1",
        [future.id],
      ),
    );
    const recovered = await Promise.all([
      store.recoverDue(100, 3),
      store.recoverDue(100, 3),
    ]);
    expect(recovered.reduce((sum, count) => sum + count, 0)).toBe(2);
    for (const notice of [a, b]) {
      expect((await noticeFacts(notice.id)).intent).toMatchObject({
        status: 'retry',
      });
      expect((await noticeFacts(notice.id)).outbox).toHaveLength(1);
      expect((await noticeFacts(notice.id)).audit).toHaveLength(1);
    }
    expect((await noticeFacts(future.id)).intent).toMatchObject({
      status: 'claimed',
    });
    await asAdmin((client) =>
      client.query(
        'delete from app.run_failure_notification_intents where id=$1',
        [future.id],
      ),
    );
  });
  it('skips a locked intent and progresses the other workspace before that lock is released', async () => {
    const a = await seedNotice({
      status: 'claimed',
      sideEffectClass: 'unsafe',
      attempts: 1,
    });
    const b = await seedNotice(
      { status: 'claimed', sideEffectClass: 'unsafe', attempts: 1 },
      other,
    );
    await asAdmin(async (pool) => {
      const holder = await pool.connect();
      try {
        await holder.query('begin');
        await holder.query(
          'select id from app.run_failure_notification_intents where id=$1 for update',
          [a.id],
        );
        expect(await store.recoverDue(100, 3)).toBe(1);
        expect((await noticeFacts(b.id)).intent).toMatchObject({
          status: 'retry',
        });
        expect((await noticeFacts(a.id)).intent).toMatchObject({
          status: 'claimed',
        });
      } finally {
        await holder.query('rollback');
        holder.release();
      }
    });
    expect(await store.recoverDue(100, 3)).toBe(1);
    expect((await noticeFacts(a.id)).outbox).toHaveLength(1);
  });

  it('rolls back all workspace decisions, retry outboxes and audits when a later audit fails', async () => {
    const a = await seedNotice({
      status: 'claimed',
      sideEffectClass: 'unsafe',
      attempts: 1,
    });
    const b = await seedNotice(
      { status: 'claimed', sideEffectClass: 'unsafe', attempts: 1 },
      other,
    );
    const before = [await noticeFacts(a.id), await noticeFacts(b.id)];
    await asAdmin((client) =>
      client.query(`create function public.refuse_notification_recovery_audit() returns trigger language plpgsql as $$ begin
      if NEW.notification_intent_id='${b.id}'::uuid then raise exception 'Audit unavailable'; end if;return NEW;end $$;
      create trigger refuse_notification_recovery_audit before insert on app.run_failure_notification_audit_facts
      for each row execute function public.refuse_notification_recovery_audit()`),
    );
    try {
      await expect(store.recoverDue(100, 3)).rejects.toBeInstanceOf(Error);
      expect([await noticeFacts(a.id), await noticeFacts(b.id)]).toEqual(
        before,
      );
    } finally {
      await asAdmin((client) =>
        client.query(
          'drop trigger refuse_notification_recovery_audit on app.run_failure_notification_audit_facts; drop function public.refuse_notification_recovery_audit()',
        ),
      );
    }
    expect(await store.recoverDue(100, 3)).toBe(2);
    for (const notice of [a, b]) {
      expect((await noticeFacts(notice.id)).outbox).toHaveLength(1);
      expect((await noticeFacts(notice.id)).audit).toHaveLength(1);
    }
  });

  it('keeps workspace authority for direct writes and lets a recovered retry claim its next attempt', async () => {
    const notice = await seedNotice(
      {
        status: 'claimed',
        sideEffectClass: 'idempotent_with_key',
        attempts: 1,
      },
      other,
    );
    const foreign = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        "update app.run_failure_notification_intents set safe_error_code='forged.reason' where id=$1",
        [notice.id],
      ),
    );
    expect(foreign.rowCount).toBe(0);
    expect(await store.recoverDue(100, 3)).toBe(1);
    const event = (await noticeFacts(notice.id)).outbox[0];
    if (event === undefined) throw new Error('Retry delivery missing');
    const claim = await store.claimDelivery({
      workspaceId: notice.workspaceId,
      intentId: notice.id,
      delivery: {
        outboxEventId: event.id,
        payloadChecksum: event.payload_checksum,
      },
      recoverySeconds: 30,
      maxAttempts: 3,
    });
    expect(claim).toMatchObject({
      kind: 'ready',
      attemptNumber: 2,
      idempotencyKey: `failure-notification:${notice.id}`,
      deliveryUnresolved: false,
    });
    await expect(
      store.completeDelivery({
        workspaceId: notice.workspaceId,
        intentId: notice.id,
        attemptNumber: 1,
        maxAttempts: 3,
        retryDelaySeconds: 0,
        result: {
          kind: 'definite_failure',
          safeErrorCode: 'provider.rejected',
          possiblyDispatched: false,
        },
      }),
    ).resolves.toBe('stale');
    expect((await noticeFacts(notice.id)).intent).toMatchObject({
      status: 'claimed',
      delivery_attempts: 2,
    });
    await asAdmin((client) =>
      client.query(
        'delete from app.run_failure_notification_intents where id=$1',
        [notice.id],
      ),
    );
  });
});
