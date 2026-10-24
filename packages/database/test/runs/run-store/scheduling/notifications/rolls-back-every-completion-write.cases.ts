import { it, expect } from 'vitest';

import { asRuntime, workerBaseUrl, workspaceA } from '../../fixtures.js';

import {
  commitPinnedFailureNotificationRun,
  failureNotificationIdentity,
  createTestFailureNotificationStore,
  closeFailureNotificationFixture,
} from '../fixture.js';

export function registerRollsBackEveryCompletionWrite(): void {
  it.each([
    {
      boundary: 'intent update',
      matches: (sql: string, parameters: readonly unknown[]) =>
        sql
          .replaceAll('"', '')
          .includes('update app.run_failure_notification_intents') &&
        parameters.includes('retry'),
    },
    {
      boundary: 'retry outbox insert',
      matches: (sql: string) =>
        sql.replaceAll('"', '').includes('insert into app.outbox_events'),
    },
    {
      boundary: 'completion audit insert',
      matches: (sql: string) =>
        sql
          .replaceAll('"', '')
          .includes('insert into app.run_failure_notification_audit_facts'),
    },
  ])(
    'rolls back every completion write after an injected $boundary failure',
    async ({ boundary, matches }) => {
      const { runId } = await commitPinnedFailureNotificationRun();
      const first = await failureNotificationIdentity(runId);
      const message = `Injected failure after ${boundary}`;
      const { store: deliveryStore } = createTestFailureNotificationStore({
        matches,
        message,
      });
      try {
        const claimed = await deliveryStore.claimDelivery({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          delivery: {
            outboxEventId: first.outbox_id,
            payloadChecksum: first.payload_checksum,
          },
          recoverySeconds: 30,
          maxAttempts: 3,
        });
        if (claimed.kind !== 'ready')
          throw new Error('Failure-injection claim missing');
        await expect(
          deliveryStore.completeDelivery({
            workspaceId: workspaceA,
            intentId: first.intent_id,
            attemptNumber: claimed.attemptNumber,
            maxAttempts: 3,
            retryDelaySeconds: 30,
            result: {
              kind: 'retry',
              safeErrorCode: 'provider.unavailable',
              possiblyDispatched: false,
            },
          }),
        ).rejects.toThrow(message);
        await expect(
          asRuntime(workerBaseUrl, workspaceA, (client) =>
            client.query<{
              completion_fact_count: number;
              next_delivery_at: Date | null;
              outbox_count: number;
              status: string;
            }>(
              `select intent.status,intent.next_delivery_at,
                      (select count(*)::int from app.outbox_events outbox
                        where outbox.aggregate_id=intent.id) outbox_count,
                      (select count(*)::int
                         from app.run_failure_notification_audit_facts fact
                        where fact.notification_intent_id=intent.id
                          and fact.fact_type='retry_scheduled') completion_fact_count
                 from app.run_failure_notification_intents intent
                where intent.workspace_id=$1 and intent.id=$2`,
              [workspaceA, first.intent_id],
            ),
          ),
        ).resolves.toMatchObject({
          rows: [
            {
              completion_fact_count: 0,
              next_delivery_at: null,
              outbox_count: 1,
              status: 'claimed',
            },
          ],
        });
        await expect(
          deliveryStore.completeDelivery({
            workspaceId: workspaceA,
            intentId: first.intent_id,
            attemptNumber: claimed.attemptNumber,
            maxAttempts: 3,
            retryDelaySeconds: 0,
            result: {
              kind: 'definite_failure',
              safeErrorCode: 'provider.rejected',
              possiblyDispatched: false,
            },
          }),
        ).resolves.toBe('completed');
      } finally {
        await closeFailureNotificationFixture(deliveryStore);
      }
    },
  );
}
