import { it, expect } from 'vitest';

import {
  Pool,
  actorId,
  apiBaseUrl,
  asOwner,
  asRuntime,
  databaseUrl,
  notificationConnectionId,
  notificationDestinationId,
  notificationSecretVersionId,
  waitForApplicationLocks,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';

import {
  commitPinnedFailureNotificationRun,
  failureNotificationIdentity,
  createTestFailureNotificationStore,
  closeFailureNotificationFixture,
} from '../fixture.js';

export function registerEnforcesDestinationDisableDispatchFencing(): void {
  it('enforces destination disable and dispatch fencing against the current configuration', async () => {
    const { runId } = await commitPinnedFailureNotificationRun();
    const first = await failureNotificationIdentity(runId);

    const { applicationName: deliveryApplicationName, store: deliveryStore } =
      createTestFailureNotificationStore();
    try {
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
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='disabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      const claims = await Promise.all([
        deliveryStore.claimDelivery(claimInput),
        deliveryStore.claimDelivery(claimInput),
      ]);
      expect(claims.map(({ kind }) => kind).sort()).toEqual(['busy', 'ready']);
      const ready = claims.find(({ kind }) => kind === 'ready');
      expect(ready?.kind).toBe('ready');
      if (ready?.kind !== 'ready') throw new Error('delivery claim missing');
      expect(ready.context.runId).toBe(runId);

      await asRuntime(apiBaseUrl, workspaceA, async (client) => {
        await client.query(
          `insert into app.failure_notification_destination_versions
               (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
             select workspace_id,destination_id,2,kind,side_effect_class,
                    jsonb_set(config,'{toEmail}','"changed@example.test"'),$3
               from app.failure_notification_destination_versions
              where workspace_id=$1 and destination_id=$2 and version=1`,
          [workspaceA, notificationDestinationId, actorId],
        );
        await client.query(
          `update app.failure_notification_destinations
                set current_config_version=2,status='disabled'
               where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        );
      });
      await expect(
        deliveryStore.loadDestination({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          workerId: 'notification-test-worker',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('Delivery destination is unavailable');
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='enabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      await expect(
        deliveryStore.loadDestination({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          workerId: 'notification-test-worker',
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        kind: 'email',
        secretVersionId: notificationSecretVersionId,
        toEmail: 'changed@example.test',
      });
      const credentialAudit = await asOwner(workspaceA, (client) =>
        client.query<{
          actor_id: string;
          actor_kind: string;
          connection_id: string;
          metadata: Record<string, unknown>;
        }>(
          `select connection_id::text,actor_kind,actor_id,metadata
               from app.connection_events
              where workspace_id=$1 and connection_id=$2
                and event_type='connection.credential_accessed'
                and actor_kind='worker' and actor_id='notification-test-worker'
              order by created_at,id`,
          [workspaceA, notificationConnectionId],
        ),
      );
      expect(credentialAudit.rows).toEqual([
        {
          actor_id: 'notification-test-worker',
          actor_kind: 'worker',
          connection_id: notificationConnectionId,
          metadata: {
            purpose: 'failure_notification.deliver',
            secretVersionId: notificationSecretVersionId,
          },
        },
      ]);
      expect(JSON.stringify(credentialAudit.rows)).not.toMatch(
        /run-store@example\.test|ciphertext|encryptedDataKey|kmsKeyReference|nonce|authTag|providerReference/u,
      );

      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.connections
              set provider_key='http'
            where workspace_id=$1 and id=$2`,
          [workspaceA, notificationConnectionId],
        ),
      );
      await expect(
        deliveryStore.loadDestination({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          workerId: 'notification-test-worker-wrong-provider',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('Delivery destination is unavailable');
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.connections
              set provider_key='email',auth_type='http_headers'
            where workspace_id=$1 and id=$2`,
          [workspaceA, notificationConnectionId],
        ),
      );
      await expect(
        deliveryStore.loadDestination({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          workerId: 'notification-test-worker-wrong-auth',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('Delivery destination is unavailable');
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.connections set auth_type='resend_api_key'
            where workspace_id=$1 and id=$2`,
          [workspaceA, notificationConnectionId],
        ),
      );

      const disablePool = new Pool({
        connectionString: databaseUrl(apiBaseUrl),
        max: 1,
      });
      const disableClient = await disablePool.connect();
      try {
        await disableClient.query('begin');
        await disableClient.query(
          "select set_config('app.workspace_id',$1,true)",
          [workspaceA],
        );
        await disableClient.query(
          `update app.failure_notification_destinations set status='disabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        );
        const disabledFence = deliveryStore
          .fenceDispatch({
            workspaceId: workspaceA,
            intentId: first.intent_id,
            attemptNumber: ready.attemptNumber,
            deliveryBinding: `email:sha256:${'a'.repeat(64)}`,
          })
          .then(
            () => ({ kind: 'resolved' as const }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          );
        await waitForApplicationLocks(deliveryApplicationName, 1);
        await disableClient.query('commit');
        const fenceResult = await disabledFence;
        expect(fenceResult.kind).toBe('rejected');
        if (fenceResult.kind !== 'rejected')
          throw new Error('disabled destination fence unexpectedly committed');
        expect(fenceResult.error).toEqual(
          expect.objectContaining({
            message: 'Delivery dispatch fence failed',
          }),
        );
      } finally {
        await disableClient.query('rollback').catch(() => undefined);
        disableClient.release();
        await disablePool.end();
      }
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='enabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      await expect(
        deliveryStore.fenceDispatch({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          deliveryBinding: `email:sha256:${'a'.repeat(64)}`,
        }),
      ).resolves.toBeUndefined();
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='disabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{ status: string }>(
            `select status from app.run_failure_notification_intents
                where workspace_id=$1 and id=$2`,
            [workspaceA, first.intent_id],
          ),
        ),
      ).resolves.toMatchObject({ rows: [{ status: 'dispatching' }] });
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='enabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      await expect(
        deliveryStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
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
