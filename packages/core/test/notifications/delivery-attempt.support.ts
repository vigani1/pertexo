import { afterAll, beforeAll, expect } from 'vitest';
import { failedRun } from './rotation.support.js';
import {
  asRuntime,
  workerBaseUrl,
  workspaceA,
} from '../runs/run-store/run-store.fixture.js';
import { createTestFailureNotificationStore } from '../runs/run-store/scheduling/scheduling.fixture.js';

export let delivery: ReturnType<
  typeof createTestFailureNotificationStore
>['store'];
beforeAll(() => {
  delivery = createTestFailureNotificationStore().store;
});
afterAll(() => delivery.close());

/** Reach each boundary through the real claim/retry protocol, without inventing prior attempts. */
export async function atAttempt(number: number) {
  const alert = await failedRun('email');
  let outbox = alert.firstDelivery;
  for (let attempt = 1; attempt <= number; attempt++) {
    const claimed = await delivery.claimDelivery({
      workspaceId: workspaceA,
      intentId: alert.intentId,
      delivery: outbox,
      recoverySeconds: 60,
      maxAttempts: 10,
    });
    expect(claimed).toMatchObject({ kind: 'ready', attemptNumber: attempt });
    if (attempt === number) break;
    await expect(
      delivery.completeDelivery({
        workspaceId: workspaceA,
        intentId: alert.intentId,
        attemptNumber: attempt,
        maxAttempts: 10,
        retryDelaySeconds: 1,
        result: {
          kind: 'retry',
          safeErrorCode: 'delivery.provider_unavailable',
          possiblyDispatched: false,
        },
      }),
    ).resolves.toBe('completed');
    const next = await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        "update app.run_failure_notification_intents set next_delivery_at=clock_timestamp()-interval '1 second' where id=$1",
        [alert.intentId],
      );
      return (
        await client.query<{ id: string; payload_checksum: string }>(
          'select id,payload_checksum from app.outbox_events where aggregate_id=$1 order by created_at desc,id desc limit 1',
          [alert.intentId],
        )
      ).rows[0];
    });
    if (next === undefined) throw new Error('Retry outbox missing');
    outbox = { outboxEventId: next.id, payloadChecksum: next.payload_checksum };
  }
  return { ...alert, attemptNumber: number };
}
