import { expect } from 'vitest';

import type { createFailureNotificationStore } from '../fixtures.js';
import { asRuntime, workerBaseUrl, workspaceA } from '../fixtures.js';

export async function assertRetrySchedule(
  deliveryStore: ReturnType<typeof createFailureNotificationStore>,
  claimInput: Parameters<
    ReturnType<typeof createFailureNotificationStore>['claimDelivery']
  >[0],
  intentId: string,
): Promise<void> {
  const scheduled = await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query<{
      due_in_seconds: number;
      id: string;
      payload_checksum: string;
    }>(
      `select extract(epoch from intent.next_delivery_at-clock_timestamp())::float8 due_in_seconds,
                            outbox.id,outbox.payload_checksum
                     from app.run_failure_notification_intents intent
                     join app.outbox_events outbox on outbox.aggregate_id=intent.id
                     where intent.id=$1 order by outbox.created_at desc,outbox.id desc limit 1`,
      [intentId],
    ),
  );
  const retry = scheduled.rows[0];
  expect(retry?.due_in_seconds).toBeGreaterThan(25);
  expect(retry?.due_in_seconds).toBeLessThanOrEqual(30);
  if (retry === undefined) throw new Error('retry schedule missing');
  await expect(
    deliveryStore.claimDelivery({
      ...claimInput,
      delivery: {
        outboxEventId: retry.id,
        payloadChecksum: retry.payload_checksum,
      },
    }),
  ).resolves.toEqual({ kind: 'busy' });
  await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query(
      `update app.run_failure_notification_intents
                   set next_delivery_at=clock_timestamp()-interval '1 second'
                   where id=$1`,
      [intentId],
    ),
  );
}
