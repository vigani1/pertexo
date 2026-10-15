import type { Pool } from 'pg';
import { expect } from 'vitest';
export async function verifyNotificationEvidence(
  database: Pool,
  messages: readonly string[],
) {
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('Private inputs stay out');
  expect(messages[0]).not.toContain('NEVER_MAIL');
  const people = await database.query<{
    workspace_id: string;
    user_id: string;
    revision: number;
    mode: string;
    time_zone: string;
  }>(
    'select workspace_id,user_id,revision,mode,time_zone from app.notice_preferences where revision>0',
  );
  expect(people.rows).toHaveLength(1);
  expect(people.rows[0]).toMatchObject({
    revision: 3,
    mode: 'off',
    time_zone: 'Europe/Paris',
  });
  const person = people.rows[0];
  if (person === undefined) throw new Error('Personal preference missing');
  expect(
    (
      await database.query(
        'select revision,followed,muted from app.notice_subscriptions where workspace_id=$1 and user_id=$2',
        [person.workspace_id, person.user_id],
      )
    ).rows,
  ).toEqual([{ revision: 2, followed: true, muted: true }]);
  expect(
    (
      await database.query(
        "select count(*)::int count from app.idempotency_records where workspace_id=$1 and operation='notice.preferences.replace'",
        [person.workspace_id],
      )
    ).rows,
  ).toEqual([{ count: 2 }]);
  expect(
    (
      await database.query(
        'select notice_kind,occurrence_count::int from app.workspace_inbox_threads where workspace_id=$1',
        [person.workspace_id],
      )
    ).rows,
  ).toEqual([{ notice_kind: 'workflow_failure', occurrence_count: 1 }]);
  await expect
    .poll(
      async () =>
        (
          await database.query<{ status: string }>(
            'select delivery.status from app.notice_mail_batches batch join app.authentication_mail_deliveries delivery on delivery.id=batch.id where batch.workspace_id=$1',
            [person.workspace_id],
          )
        ).rows,
    )
    .toEqual([{ status: 'submitted' }]);
  expect(
    (
      await database.query(
        'select count(*)::int count from app.notice_mail_items where workspace_id=$1',
        [person.workspace_id],
      )
    ).rows,
  ).toEqual([{ count: 1 }]);
  expect(
    (
      await database.query(
        'select status from app.workflow_runs where workspace_id=$1',
        [person.workspace_id],
      )
    ).rows,
  ).toEqual([{ status: 'failed' }]);
}
