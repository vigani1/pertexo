import { FailureNotificationStateError } from '../../../../../src/notifications/errors.js';
import { it, expect } from 'vitest';

import {
  asOwner,
  asRuntime,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';

import {
  commitPinnedFailureNotificationRun,
  failureNotificationIdentity,
  createTestFailureNotificationStore,
  closeFailureNotificationFixture,
} from '../fixture.js';

export function registerDistinguishesBusyDueBoundaryTerminal(): void {
  it('rejects an unpinned intent without claiming or advancing its attempt', async () => {
    const run = await commitPinnedFailureNotificationRun();
    const identity = await failureNotificationIdentity(run.runId);
    await asOwner(workspaceA, (client) =>
      client.query(
        'update app.run_failure_notification_intents set connection_secret_version_id=null where workspace_id=$1 and id=$2',
        [workspaceA, identity.intent_id],
      ),
    );
    const { store } = createTestFailureNotificationStore();
    try {
      const claim = store.claimDelivery({
        workspaceId: workspaceA,
        intentId: identity.intent_id,
        delivery: {
          outboxEventId: identity.outbox_id,
          payloadChecksum: identity.payload_checksum,
        },
        recoverySeconds: 30,
        maxAttempts: 3,
      });
      await expect(claim).rejects.toThrow('Intent credential pin is missing');
      await expect(claim).rejects.not.toBeInstanceOf(
        FailureNotificationStateError,
      );
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            'select status,delivery_attempts from app.run_failure_notification_intents where workspace_id=$1 and id=$2',
            [workspaceA, identity.intent_id],
          ),
        ),
      ).resolves.toMatchObject({
        rows: [{ status: 'pending', delivery_attempts: 0 }],
      });
    } finally {
      await closeFailureNotificationFixture(store);
    }
  });

  it('distinguishes busy, due-boundary, terminal, and lowered attempt-ceiling claims', async () => {
    const firstRun = await commitPinnedFailureNotificationRun();
    const first = await failureNotificationIdentity(firstRun.runId);
    const secondRun = await commitPinnedFailureNotificationRun();
    const second = await failureNotificationIdentity(secondRun.runId);
    const { store: deliveryStore } = createTestFailureNotificationStore();
    const claim = (identity: typeof first, maxAttempts = 3) => ({
      workspaceId: workspaceA,
      intentId: identity.intent_id,
      delivery: {
        outboxEventId: identity.outbox_id,
        payloadChecksum: identity.payload_checksum,
      },
      recoverySeconds: 30,
      maxAttempts,
    });
    const latestDelivery = async (intentId: string) => {
      const outbox = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ id: string; payload_checksum: string }>(
          `select id,payload_checksum from app.outbox_events
            where workspace_id=$1 and aggregate_id=$2
            order by created_at desc,id desc limit 1`,
          [workspaceA, intentId],
        ),
      );
      const latest = outbox.rows[0];
      if (latest === undefined) throw new Error('Retry outbox missing');
      return {
        workspaceId: workspaceA,
        intentId,
        delivery: {
          outboxEventId: latest.id,
          payloadChecksum: latest.payload_checksum,
        },
        recoverySeconds: 30,
        maxAttempts: 3,
      };
    };
    try {
      const firstReady = await deliveryStore.claimDelivery(claim(first));
      if (firstReady.kind !== 'ready') throw new Error('First claim missing');
      await expect(deliveryStore.claimDelivery(claim(first))).resolves.toEqual({
        kind: 'busy',
      });
      await expect(
        deliveryStore.fenceDispatch({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: firstReady.attemptNumber,
          deliveryBinding: `email:sha256:${'c'.repeat(64)}`,
        }),
      ).resolves.toBeUndefined();
      await expect(deliveryStore.claimDelivery(claim(first))).resolves.toEqual({
        kind: 'busy',
      });
      await expect(
        deliveryStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: firstReady.attemptNumber,
          maxAttempts: 3,
          retryDelaySeconds: 0,
          result: {
            kind: 'definite_failure',
            safeErrorCode: 'provider.rejected',
            possiblyDispatched: false,
          },
        }),
      ).resolves.toBe('completed');
      await expect(deliveryStore.claimDelivery(claim(first))).resolves.toEqual({
        kind: 'terminal',
      });

      const secondReady = await deliveryStore.claimDelivery(claim(second));
      if (secondReady.kind !== 'ready') throw new Error('Second claim missing');
      await expect(
        deliveryStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: second.intent_id,
          attemptNumber: secondReady.attemptNumber,
          maxAttempts: 3,
          retryDelaySeconds: 30,
          result: {
            kind: 'retry',
            safeErrorCode: 'provider.unavailable',
            possiblyDispatched: false,
          },
        }),
      ).resolves.toBe('completed');
      const attemptTwo = await latestDelivery(second.intent_id);
      await expect(deliveryStore.claimDelivery(attemptTwo)).resolves.toEqual({
        kind: 'busy',
      });
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.run_failure_notification_intents
              set next_delivery_at=clock_timestamp()
            where workspace_id=$1 and id=$2`,
          [workspaceA, second.intent_id],
        ),
      );
      const attemptTwoReady = await deliveryStore.claimDelivery(attemptTwo);
      expect(attemptTwoReady).toMatchObject({
        attemptNumber: 2,
        kind: 'ready',
      });
      if (attemptTwoReady.kind !== 'ready')
        throw new Error('Due-boundary claim missing');
      await expect(
        deliveryStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: second.intent_id,
          attemptNumber: attemptTwoReady.attemptNumber,
          maxAttempts: 3,
          retryDelaySeconds: 30,
          result: {
            kind: 'retry',
            safeErrorCode: 'provider.unavailable',
            possiblyDispatched: false,
          },
        }),
      ).resolves.toBe('completed');
      const attemptThree = await latestDelivery(second.intent_id);
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.run_failure_notification_intents
              set next_delivery_at=clock_timestamp()
            where workspace_id=$1 and id=$2`,
          [workspaceA, second.intent_id],
        ),
      );
      await expect(
        deliveryStore.claimDelivery({ ...attemptThree, maxAttempts: 2 }),
      ).resolves.toEqual({ kind: 'terminal' });
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{
            delivery_attempts: number;
            safe_error_code: string;
            status: string;
          }>(
            `select status,delivery_attempts,safe_error_code
               from app.run_failure_notification_intents
              where workspace_id=$1 and id=$2`,
            [workspaceA, second.intent_id],
          ),
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            delivery_attempts: 2,
            safe_error_code: 'delivery.attempts_exhausted',
            status: 'dead_letter',
          },
        ],
      });
    } finally {
      await closeFailureNotificationFixture(deliveryStore);
    }
  });
}
