import { it, expect } from 'vitest';
import { ZodError } from 'zod';

import {
  asOwner,
  asRuntime,
  randomUUID,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';

import {
  commitPinnedFailureNotificationRun,
  failureNotificationIdentity,
  createTestFailureNotificationStore,
  closeFailureNotificationFixture,
} from '../fixture.js';

export function registerRejectsEachForgedQueueIdentity(): void {
  it('rejects each forged queue identity and corrupt context before claiming', async () => {
    const { runId } = await commitPinnedFailureNotificationRun();
    const first = await failureNotificationIdentity(runId);
    const { store: deliveryStore } = createTestFailureNotificationStore();
    const claimInput = {
      workspaceId: workspaceA,
      intentId: first.intent_id,
      delivery: {
        outboxEventId: first.outbox_id,
        payloadChecksum: first.payload_checksum,
      },
      recoverySeconds: 30,
      maxAttempts: 3,
    } as const;
    const originalOutbox = await asOwner(workspaceA, (client) =>
      client.query<{
        aggregate_id: string;
        aggregate_type: string;
        job_name: string;
        payload: unknown;
        payload_checksum: string;
      }>(
        `select aggregate_id,aggregate_type,job_name,payload,payload_checksum
           from app.outbox_events where workspace_id=$1 and id=$2`,
        [workspaceA, first.outbox_id],
      ),
    );
    const authoritative = originalOutbox.rows[0];
    if (authoritative === undefined)
      throw new Error('Notification outbox fixture missing');
    const assertUnclaimed = async (): Promise<void> => {
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{ delivery_attempts: number; status: string }>(
            `select status,delivery_attempts
               from app.run_failure_notification_intents
              where workspace_id=$1 and id=$2`,
            [workspaceA, first.intent_id],
          ),
        ),
      ).resolves.toMatchObject({
        rows: [{ delivery_attempts: 0, status: 'pending' }],
      });
    };
    const restoreOutbox = () =>
      asOwner(workspaceA, (client) =>
        client.query(
          `update app.outbox_events
              set aggregate_id=$3,aggregate_type=$4,job_name=$5,payload=$6::jsonb,
                  payload_checksum=$7
            where workspace_id=$1 and id=$2`,
          [
            workspaceA,
            first.outbox_id,
            authoritative.aggregate_id,
            authoritative.aggregate_type,
            authoritative.job_name,
            JSON.stringify(authoritative.payload),
            authoritative.payload_checksum,
          ],
        ),
      );
    const mutations = [
      {
        name: 'aggregate id',
        sql: 'update app.outbox_events set aggregate_id=$3 where workspace_id=$1 and id=$2',
        value: randomUUID(),
        checksum: first.payload_checksum,
      },
      {
        name: 'aggregate type',
        sql: 'update app.outbox_events set aggregate_type=$3 where workspace_id=$1 and id=$2',
        value: 'workflow-run',
        checksum: first.payload_checksum,
      },
      {
        name: 'job name',
        sql: 'update app.outbox_events set job_name=$3 where workspace_id=$1 and id=$2',
        value: 'advance-workflow-run',
        checksum: first.payload_checksum,
      },
      {
        name: 'stored checksum',
        sql: 'update app.outbox_events set payload_checksum=$3 where workspace_id=$1 and id=$2',
        value: 'f'.repeat(64),
        checksum: 'f'.repeat(64),
      },
      {
        name: 'stored payload',
        sql: `update app.outbox_events
                 set payload=jsonb_set(payload,'{tampered}','true'::jsonb)
               where workspace_id=$1 and id=$2`,
        checksum: first.payload_checksum,
      },
    ] as const;
    try {
      for (const mutation of mutations) {
        try {
          await asOwner(workspaceA, (client) =>
            client.query(
              mutation.sql,
              'value' in mutation
                ? [workspaceA, first.outbox_id, mutation.value]
                : [workspaceA, first.outbox_id],
            ),
          );
          await expect(
            deliveryStore.claimDelivery({
              ...claimInput,
              delivery: {
                ...claimInput.delivery,
                payloadChecksum: mutation.checksum,
              },
            }),
            mutation.name,
          ).rejects.toThrow('Delivery identity mismatch');
          await assertUnclaimed();
        } finally {
          await restoreOutbox();
        }
      }

      await expect(
        deliveryStore.claimDelivery({
          ...claimInput,
          delivery: {
            ...claimInput.delivery,
            payloadChecksum: 'e'.repeat(64),
          },
        }),
      ).rejects.toThrow('Delivery identity mismatch');
      await assertUnclaimed();

      const originalContext = await asOwner(workspaceA, (client) =>
        client.query<{ context: unknown; context_checksum: string }>(
          `select context,context_checksum
             from app.run_failure_notification_intents
            where workspace_id=$1 and id=$2`,
          [workspaceA, first.intent_id],
        ),
      );
      const persisted = originalContext.rows[0];
      if (persisted === undefined)
        throw new Error('Notification context fixture missing');
      try {
        await asOwner(workspaceA, (client) =>
          client.query(
            `update app.run_failure_notification_intents
                set context='{}'::jsonb
              where workspace_id=$1 and id=$2`,
            [workspaceA, first.intent_id],
          ),
        );
        await expect(
          deliveryStore.claimDelivery(claimInput),
        ).rejects.toBeInstanceOf(ZodError);
        await assertUnclaimed();
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            `update app.run_failure_notification_intents
                set context=$3::jsonb,context_checksum=$4
              where workspace_id=$1 and id=$2`,
            [
              workspaceA,
              first.intent_id,
              JSON.stringify(persisted.context),
              persisted.context_checksum,
            ],
          ),
        );
      }
      try {
        await asOwner(workspaceA, (client) =>
          client.query(
            `update app.run_failure_notification_intents
                set context_checksum=$3
              where workspace_id=$1 and id=$2`,
            [workspaceA, first.intent_id, 'd'.repeat(64)],
          ),
        );
        await expect(deliveryStore.claimDelivery(claimInput)).rejects.toThrow(
          'Intent checksum mismatch',
        );
        await assertUnclaimed();
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            `update app.run_failure_notification_intents
                set context_checksum=$3
              where workspace_id=$1 and id=$2`,
            [workspaceA, first.intent_id, persisted.context_checksum],
          ),
        );
      }

      const validClaim = await deliveryStore.claimDelivery(claimInput);
      expect(validClaim).toMatchObject({ attemptNumber: 1, kind: 'ready' });
      if (validClaim.kind !== 'ready')
        throw new Error('Valid notification claim missing');
      await expect(
        deliveryStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: validClaim.attemptNumber,
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
  });
}
