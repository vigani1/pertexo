import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/primitives';
import { atAttempt, delivery } from './delivery-attempt.support.js';
import { emailBinding, fence } from './rotation.support.js';
import { asAdmin, workspaceA } from '../runs/run-store/run-store.fixture.js';

const retry = {
  kind: 'retry',
  possiblyDispatched: false,
  safeErrorCode: 'provider.unavailable',
} as const;
const complete = (
  intentId: string,
  attemptNumber = 1,
  retryDelaySeconds = 5,
  maxAttempts = 10,
) => ({
  workspaceId: workspaceA,
  intentId,
  attemptNumber,
  maxAttempts,
  retryDelaySeconds,
  result: retry,
});
async function stored(intentId: string) {
  return asAdmin(async (pool) => {
    const intent = await pool.query<Record<string, unknown>>(
      'select *,round(extract(epoch from next_delivery_at-updated_at))::int retry_delay from app.run_failure_notification_intents where id=$1',
      [intentId],
    );
    const audit = await pool.query<Record<string, unknown>>(
      'select fact_type,attempt_number,safe_error_code,possibly_dispatched from app.run_failure_notification_audit_facts where notification_intent_id=$1 order by occurred_at,id',
      [intentId],
    );
    const outbox = await pool.query<{
      id: string;
      payload: {
        workspaceId: string;
        notificationIntentId: string;
        outboxEventId: string;
      };
      payload_checksum: string;
      available_at: Date;
    }>(
      'select id,job_name,aggregate_type,aggregate_id,payload,payload_checksum,available_at from app.outbox_events where aggregate_id=$1 order by created_at,id',
      [intentId],
    );
    const row = intent.rows[0];
    if (row === undefined) throw new Error('Intent missing');
    return { intent: row, audit: audit.rows, outbox: outbox.rows };
  });
}

it('persists retry status, the maximum delay, one matching outbox delivery and its audit atomically', async () => {
  const alert = await atAttempt(1);
  const before = await stored(alert.intentId);
  const input = complete(alert.intentId, 1, 3_600);
  await expect(delivery.completeDelivery(input)).resolves.toBe('completed');
  const after = await stored(alert.intentId);
  expect(after.intent).toMatchObject({
    status: 'retry',
    delivery_attempts: 1,
    safe_error_code: retry.safeErrorCode,
    possibly_dispatched: false,
    dispatch_marked_at: null,
    recovery_at: null,
    completed_at: null,
  });
  const due = after.intent.next_delivery_at as Date;
  expect(after.intent.retry_delay).toBe(3_600);
  expect(after.audit).toEqual([
    ...before.audit,
    {
      fact_type: 'retry_scheduled',
      attempt_number: 1,
      safe_error_code: retry.safeErrorCode,
      possibly_dispatched: false,
    },
  ]);
  const added = after.outbox.filter(
    (row) => !before.outbox.some((prior) => prior.id === row.id),
  );
  expect(added).toHaveLength(1);
  const event = added[0];
  expect(event).toMatchObject({
    job_name: 'deliver-run-failure-notification',
    aggregate_type: 'run-failure-notification',
    aggregate_id: alert.intentId,
    available_at: due,
    payload: {
      workspaceId: workspaceA,
      notificationIntentId: alert.intentId,
      outboxEventId: event?.id,
    },
  });
  expect(event?.payload_checksum).toBe(
    canonicalOutboxPayloadChecksum(event?.payload),
  );
  await expect(delivery.completeDelivery(input)).resolves.toBe('stale');
  expect(await stored(alert.intentId)).toEqual(after);
});

it.each([
  { number: 1, maximum: 1 },
  { number: 10, maximum: 10 },
])(
  'dead-letters exhausted attempt $number with zero delay and no new delivery',
  async ({ number, maximum }) => {
    const alert = await atAttempt(number);
    const before = await stored(alert.intentId);
    await expect(
      delivery.completeDelivery(complete(alert.intentId, number, 0, maximum)),
    ).resolves.toBe('completed');
    const after = await stored(alert.intentId);
    expect(after.intent).toMatchObject({
      status: 'dead_letter',
      next_delivery_at: null,
      recovery_at: null,
      dispatch_marked_at: null,
      possibly_dispatched: false,
      safe_error_code: retry.safeErrorCode,
    });
    expect(after.intent.completed_at).toBeInstanceOf(Date);
    expect(after.outbox).toEqual(before.outbox);
    expect(after.audit).toEqual([
      ...before.audit,
      {
        fact_type: 'dead_lettered',
        attempt_number: number,
        safe_error_code: retry.safeErrorCode,
        possibly_dispatched: false,
      },
    ]);
  },
);

it.each(['delivered', 'outcome_unknown'] as const)(
  'persists a fenced %s result and its final audit without another delivery',
  async (kind) => {
    const alert = await atAttempt(10);
    await fence(alert, 10, emailBinding('a'));
    const before = await stored(alert.intentId);
    const result =
      kind === 'delivered'
        ? {
            kind,
            possiblyDispatched: true as const,
            providerReference: 'provider-message-1',
          }
        : {
            kind,
            possiblyDispatched: true as const,
            safeErrorCode: 'provider.ambiguous',
          };
    const input = { ...complete(alert.intentId, 10, 0), result };
    await expect(delivery.completeDelivery(input)).resolves.toBe('completed');
    const after = await stored(alert.intentId);
    expect(after.intent).toMatchObject({
      status: kind,
      possibly_dispatched: true,
      next_delivery_at: null,
      recovery_at: null,
      dispatch_marked_at: null,
      provider_reference: kind === 'delivered' ? 'provider-message-1' : null,
      safe_error_code: kind === 'delivered' ? null : 'provider.ambiguous',
    });
    expect(after.intent.completed_at).toBeInstanceOf(Date);
    expect(after.outbox).toEqual(before.outbox);
    expect(after.audit).toEqual([
      ...before.audit,
      {
        fact_type: kind,
        attempt_number: 10,
        safe_error_code: kind === 'delivered' ? null : 'provider.ambiguous',
        possibly_dispatched: true,
      },
    ]);
    await expect(delivery.completeDelivery(input)).resolves.toBe('stale');
    expect(await stored(alert.intentId)).toEqual(after);
  },
);

it('rolls back retry status when its outbox cannot be written', async () => {
  const alert = await atAttempt(1);
  const before = await stored(alert.intentId);
  await asAdmin((pool) =>
    pool.query(
      `alter table app.outbox_events add constraint reject_completion_retry check (aggregate_id <> '${alert.intentId}'::uuid) not valid`,
    ),
  );
  try {
    await expect(
      delivery.completeDelivery(complete(alert.intentId)),
    ).rejects.toThrow();
    expect(await stored(alert.intentId)).toEqual(before);
  } finally {
    await asAdmin((pool) =>
      pool.query(
        'alter table app.outbox_events drop constraint reject_completion_retry',
      ),
    );
  }
  await expect(
    delivery.completeDelivery(complete(alert.intentId)),
  ).resolves.toBe('completed');
});

it.each([
  'zero delay',
  'claimed delivered',
  'claimed unknown',
  'canceled',
] as const)('refuses %s completion without changing rows', async (scenario) => {
  const alert = await atAttempt(1);
  const before = await stored(alert.intentId);
  let input: Parameters<typeof delivery.completeDelivery>[0] = complete(
    alert.intentId,
  );
  let reason = 'Predispatch completion result is incompatible';
  switch (scenario) {
    case 'zero delay':
      input = { ...input, retryDelaySeconds: 0 };
      reason = 'Retry delay must be positive';
      break;
    case 'claimed delivered':
      input = {
        ...input,
        result: {
          kind: 'delivered',
          possiblyDispatched: true,
          providerReference: 'invalid',
        },
      };
      break;
    case 'claimed unknown':
      input = {
        ...input,
        result: {
          kind: 'outcome_unknown',
          possiblyDispatched: true,
          safeErrorCode: 'provider.ambiguous',
        },
      };
      break;
    case 'canceled':
      input = {
        ...input,
        signal: AbortSignal.abort(new Error('completion canceled')),
      };
      reason = 'aborted';
      break;
  }
  await expect(delivery.completeDelivery(input)).rejects.toThrow(reason);
  expect(await stored(alert.intentId)).toEqual(before);
});

it.each(['missing', 'older', 'newer'] as const)(
  'returns stale for a %s attempt without changing intent, audit or outbox',
  async (scenario) => {
    const alert = await atAttempt(scenario === 'older' ? 2 : 1);
    const before = await stored(alert.intentId);
    await expect(
      delivery.completeDelivery(
        complete(
          scenario === 'missing' ? randomUUID() : alert.intentId,
          scenario === 'newer' ? 2 : 1,
        ),
      ),
    ).resolves.toBe('stale');
    expect(await stored(alert.intentId)).toEqual(before);
  },
);
