import { afterAll, beforeAll, expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createStalledWorkStore } from '../../../src/runs/stalled/stalled-work.store.js';
import { ErrorWorkflowDeliveryMismatchError } from '../../../src/runs/error-workflows/error-workflow.errors.js';
import { admin } from '../../lifecycle/calls/fixtures.js';
import { maintenanceUrl } from '../../lifecycle/retention.support.js';
import {
  beforeAllFixture1,
  afterAllFixture2,
  fixture,
  delivery,
  intent,
  store,
} from './delivery/fixture.js';

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);

it.each(['unconfirmed', 'already_failed'] as const)(
  'repairs a pending error handler whose delivery is %s without admitting it twice',
  async (kind) => {
    const f = await fixture();
    await f.produce();
    const original = await delivery(f);
    await admin.query(
      `update app.outbox_events set published_at=case when $2='unconfirmed' then clock_timestamp()-interval '2 hours' end,
    delivery_due_at=clock_timestamp()-interval '1 hour',
    redeliveries=30,failed_at=case when $2='already_failed' then clock_timestamp() end,
    last_error_code=case when $2='already_failed' then 'delivery.never_confirmed' end where id=$1`,
      [original.outboxEventId, kind],
    );
    const recovery = createStalledWorkStore(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
    );
    try {
      const results = await Promise.all([
        recovery.recoverDue(50, new AbortController().signal),
        recovery.recoverDue(50, new AbortController().signal),
      ]);
      expect(results.flatMap((result) => result.failed)).toEqual([]);
      expect(results.flatMap((result) => result.stagesFailed)).toEqual([]);
      const replacement = await delivery(f);
      expect(replacement.outboxEventId).not.toBe(original.outboxEventId);
      expect(await intent(f)).toMatchObject({
        status: 'pending',
        outbox_event_id: replacement.outboxEventId,
      });
      await expect(store.dispatch(original)).rejects.toBeInstanceOf(
        ErrorWorkflowDeliveryMismatchError,
      );
      await Promise.all([
        store.dispatch(replacement),
        store.dispatch(replacement),
      ]);
      await recovery.recoverDue(50, new AbortController().signal);
      expect(await intent(f)).toMatchObject({
        status: 'accepted',
        accepted_run_id: expect.any(String) as unknown,
      });
      expect(
        (
          await admin.query(
            "select id from app.workflow_runs where workspace_id=$1 and trigger_type='workflow_error'",
            [f.workspaceId],
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await admin.query(
            "select id from app.outbox_events where workspace_id=$1 and job_name='start-error-workflow'",
            [f.workspaceId],
          )
        ).rows,
      ).toHaveLength(2);
      expect(
        (
          await admin.query(
            'select completed_at is not null completed from app.inbox_receipts where message_id=$1',
            [replacement.outboxEventId],
          )
        ).rows,
      ).toEqual([{ completed: true }]);
      expect(
        (
          await admin.query(
            'select failed_at is not null failed,last_error_code from app.outbox_events where id=$1',
            [original.outboxEventId],
          )
        ).rows,
      ).toEqual([
        { failed: true, last_error_code: 'delivery.never_confirmed' },
      ]);
    } finally {
      await recovery.close();
    }
  },
);

it('rolls back a replacement delivery if the intent pointer cannot commit, then repairs on retry', async () => {
  const f = await fixture();
  await f.produce();
  const original = await delivery(f);
  await admin.query(
    `update app.outbox_events set failed_at=clock_timestamp(),delivery_due_at=clock_timestamp(),last_error_code='delivery.never_confirmed' where id=$1`,
    [original.outboxEventId],
  );
  const recovery = createStalledWorkStore(
    parseDatabaseConfig({ connectionString: maintenanceUrl, max: 1 }),
  );
  try {
    await admin.query(`create function public.refuse_error_delivery_pointer() returns trigger language plpgsql as $$ begin raise exception 'Intent write unavailable'; end $$;
    create trigger refuse_error_delivery_pointer before update of outbox_event_id on app.run_error_workflow_intents for each row execute function public.refuse_error_delivery_pointer()`);
    try {
      const result = await recovery.recoverDue(
        50,
        new AbortController().signal,
      );
      expect(result.failed).toHaveLength(1);
      expect((await delivery(f)).outboxEventId).toBe(original.outboxEventId);
      expect(
        (
          await admin.query(
            "select id from app.outbox_events where workspace_id=$1 and job_name='start-error-workflow'",
            [f.workspaceId],
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await admin.query(
            'select delivery_due_at is not null repair_due from app.outbox_events where id=$1',
            [original.outboxEventId],
          )
        ).rows,
      ).toEqual([{ repair_due: true }]);
    } finally {
      await admin.query(
        'drop trigger refuse_error_delivery_pointer on app.run_error_workflow_intents; drop function public.refuse_error_delivery_pointer()',
      );
    }
    expect(
      (await recovery.recoverDue(50, new AbortController().signal)).failed,
    ).toEqual([]);
    const replacement = await delivery(f);
    expect(replacement.outboxEventId).not.toBe(original.outboxEventId);
    await store.dispatch(replacement);
    expect(await intent(f)).toMatchObject({ status: 'accepted' });
  } finally {
    await recovery.close();
  }
});
