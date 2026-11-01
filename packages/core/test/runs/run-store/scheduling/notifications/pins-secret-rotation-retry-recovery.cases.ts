import { it, expect, vi } from 'vitest';

import {
  actorId,
  apiBaseUrl,
  asRuntime,
  notificationConnectionId,
  randomUUID,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';

import {
  commitPinnedFailureNotificationRun,
  failureNotificationIdentity,
  createTestFailureNotificationStore,
  closeFailureNotificationFixture,
  assertRetrySchedule,
} from '../fixture.js';

export function registerPinsSecretRotationRetryRecovery(): void {
  it('pins secret rotation while retry recovery preserves historical uncertainty', async () => {
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
      recoverySeconds: 1,
      maxAttempts: 3,
    } as const;
    try {
      const firstClaim = await deliveryStore.claimDelivery(claimInput);
      if (firstClaim.kind !== 'ready')
        throw new Error('initial delivery was not claimable');
      await expect(
        deliveryStore.fenceDispatch({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: firstClaim.attemptNumber,
          deliveryBinding: `email:sha256:${'a'.repeat(64)}`,
        }),
      ).resolves.toBeUndefined();
      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.run_failure_notification_intents
             set recovery_at=clock_timestamp()-interval '1 second'
             where id=$1`,
          [first.intent_id],
        ),
      );
      await expect(deliveryStore.recoverDue(10, 3)).resolves.toBe(1);
      for (let attempt = 2; attempt <= 3; attempt += 1) {
        const next = await asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{ id: string; payload_checksum: string }>(
            `select id,payload_checksum from app.outbox_events
               where aggregate_id=$1 order by created_at desc,id desc limit 1`,
            [first.intent_id],
          ),
        );
        const outbox = next.rows[0];
        if (outbox === undefined) throw new Error('retry outbox missing');
        const claimed = await deliveryStore.claimDelivery({
          ...claimInput,
          delivery: {
            outboxEventId: outbox.id,
            payloadChecksum: outbox.payload_checksum,
          },
        });
        if (claimed.kind !== 'ready')
          throw new Error('retry was not claimable');
        if (attempt === 2) {
          expect(claimed.deliveryBinding).toBe(
            `email:sha256:${'a'.repeat(64)}`,
          );
          await expect(
            deliveryStore.fenceDispatch({
              workspaceId: workspaceA,
              intentId: first.intent_id,
              attemptNumber: claimed.attemptNumber,
              deliveryBinding: `email:sha256:${'b'.repeat(64)}`,
            }),
          ).rejects.toThrow('Delivery dispatch fence failed');
          await expect(
            deliveryStore.fenceDispatch({
              workspaceId: workspaceA,
              intentId: first.intent_id,
              attemptNumber: claimed.attemptNumber,
              deliveryBinding: `email:sha256:${'a'.repeat(64)}`,
            }),
          ).resolves.toBeUndefined();
          const rotatedSecretVersionId = randomUUID();
          await asRuntime(apiBaseUrl, workspaceA, async (client) => {
            await client.query(
              `insert into app.connection_secret_versions (
                   id,workspace_id,connection_id,kms_key_reference,
                   encrypted_data_key,ciphertext,nonce,auth_tag,created_by
                 ) values ($1,$2,$3,'kms','key2','cipher2','BBBBBBBBBBBBBBBB',
                   'BBBBBBBBBBBBBBBBBBBBBB',$4)`,
              [
                rotatedSecretVersionId,
                workspaceA,
                notificationConnectionId,
                actorId,
              ],
            );
            await client.query(
              `update app.connections set current_secret_version_id=$3,health_revision=health_revision+1,
                last_health_transition_at=clock_timestamp(),last_health_transition_source='rotation'
                  where workspace_id=$1 and id=$2`,
              [workspaceA, notificationConnectionId, rotatedSecretVersionId],
            );
          });
          await expect(
            deliveryStore.loadDestination({
              workspaceId: workspaceA,
              intentId: first.intent_id,
              attemptNumber: claimed.attemptNumber,
              workerId: 'notification-test-worker',
              signal: new AbortController().signal,
            }),
          ).rejects.toThrow('Delivery destination is unavailable');
        }
        const workerClock =
          attempt === 2
            ? vi
                .spyOn(Date, 'now')
                .mockReturnValue(Date.parse('2099-01-01T00:00:00.000Z'))
            : undefined;
        try {
          await expect(
            deliveryStore.completeDelivery({
              workspaceId: workspaceA,
              intentId: first.intent_id,
              attemptNumber: claimed.attemptNumber,
              maxAttempts: 3,
              retryDelaySeconds: attempt === 2 ? 30 : 0,
              result: {
                kind: 'retry',
                safeErrorCode: 'provider.unavailable',
                possiblyDispatched: false,
              },
            }),
          ).resolves.toBe('completed');
          if (attempt === 2) {
            await assertRetrySchedule(
              deliveryStore,
              claimInput,
              first.intent_id,
            );
          }
        } finally {
          workerClock?.mockRestore();
        }
      }
      const terminal = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          status: string;
          run_status: string;
          event_count: number;
        }>(
          `select intent.status,run.status run_status,
                    (select count(*)::int from app.run_events event
                      where event.workflow_run_id=run.id) event_count
             from app.run_failure_notification_intents intent
             join app.workflow_runs run on run.id=intent.workflow_run_id
             where intent.id=$1`,
          [first.intent_id],
        ),
      );
      expect(terminal.rows[0]).toEqual({
        status: 'outcome_unknown',
        run_status: 'failed',
        event_count: 3,
      });

      const exhaustedId = randomUUID();
      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.run_failure_notification_intents (
               id,workspace_id,workflow_run_id,terminal_event_sequence,destination_id,destination_config_version,side_effect_class,
               connection_secret_version_id,delivery_binding,context,context_checksum,
               status,delivery_attempts,dispatch_marked_at,recovery_at,possibly_dispatched
             ) select $1,workspace_id,workflow_run_id,terminal_event_sequence+2,destination_id,destination_config_version,'idempotent_with_key',
                      connection_secret_version_id,$3,context,context_checksum,
                      'dispatching',3,clock_timestamp(),clock_timestamp()+interval '1 minute',true
                 from app.run_failure_notification_intents where id=$2`,
          [exhaustedId, first.intent_id, `email:sha256:${'b'.repeat(64)}`],
        ),
      );
      await expect(
        deliveryStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: exhaustedId,
          attemptNumber: 3,
          maxAttempts: 3,
          retryDelaySeconds: 0,
          result: {
            kind: 'retry',
            safeErrorCode: 'delivery.provider_ambiguous',
            possiblyDispatched: true,
          },
        }),
      ).resolves.toBe('completed');
      const exhausted = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ status: string; possibly_dispatched: boolean }>(
          `select status,possibly_dispatched
                 from app.run_failure_notification_intents where id=$1`,
          [exhaustedId],
        ),
      );
      expect(exhausted.rows[0]).toEqual({
        status: 'outcome_unknown',
        possibly_dispatched: true,
      });
    } finally {
      await closeFailureNotificationFixture(deliveryStore);
    }
  });
}
