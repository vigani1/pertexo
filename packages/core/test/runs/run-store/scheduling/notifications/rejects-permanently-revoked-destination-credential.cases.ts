import { it, expect } from 'vitest';

import {
  asOwner,
  notificationConnectionId,
  notificationDestinationId,
  notificationSecretVersionId,
  randomUUID,
  workspaceA,
} from '../../fixtures.js';

import {
  commitPinnedFailureNotificationRun,
  failureNotificationIdentity,
  createTestFailureNotificationStore,
} from '../fixture.js';

export function registerRejectsPermanentlyRevokedDestinationCredential(): void {
  it('rejects a permanently revoked destination credential without reviving it', async () => {
    const connectionId = randomUUID(),
      secretVersionId = randomUUID(),
      destinationId = randomUUID();
    await asOwner(workspaceA, async (client) => {
      await client.query(
        `insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by)
        select $3,workspace_id,provider_key,'Isolated revoked notification',auth_type,'active',$4,created_by
        from app.connections where workspace_id=$1 and id=$2`,
        [workspaceA, notificationConnectionId, connectionId, secretVersionId],
      );
      await client.query(
        `insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
        select $3,workspace_id,$4,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by
        from app.connection_secret_versions where workspace_id=$1 and id=$2`,
        [
          workspaceA,
          notificationSecretVersionId,
          secretVersionId,
          connectionId,
        ],
      );
      await client.query(
        `insert into app.failure_notification_destinations(id,workspace_id,kind,status,current_config_version,created_by)
        select $3,workspace_id,kind,'enabled',1,created_by from app.failure_notification_destinations where workspace_id=$1 and id=$2`,
        [workspaceA, notificationDestinationId, destinationId],
      );
      await client.query(
        `insert into app.failure_notification_destination_versions(workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
        select workspace_id,$3,1,kind,side_effect_class,jsonb_set(config,'{connectionId}',to_jsonb($4::text)),created_by
        from app.failure_notification_destination_versions where workspace_id=$1 and destination_id=$2 and version=1`,
        [workspaceA, notificationDestinationId, destinationId, connectionId],
      );
    });
    const { runId } = await commitPinnedFailureNotificationRun({
      destinationId,
      secretVersionId,
    });
    const identity = await failureNotificationIdentity(runId);
    const { store } = createTestFailureNotificationStore();
    try {
      const claimed = await store.claimDelivery({
        workspaceId: workspaceA,
        intentId: identity.intent_id,
        delivery: {
          outboxEventId: identity.outbox_id,
          payloadChecksum: identity.payload_checksum,
        },
        recoverySeconds: 1,
        maxAttempts: 3,
      });
      expect(claimed.kind).toBe('ready');
      if (claimed.kind !== 'ready')
        throw new Error('Isolated revocation fixture was not claimed');
      await asOwner(workspaceA, async (client) => {
        await client.query(
          `update app.connections set status='revoked',health_revision=health_revision+1,
          last_health_transition_at=clock_timestamp(),last_health_transition_source='revoke'
          where workspace_id=$1 and id=$2`,
          [workspaceA, connectionId],
        );
      });
      await expect(
        store.loadDestination({
          workspaceId: workspaceA,
          intentId: identity.intent_id,
          attemptNumber: claimed.attemptNumber,
          workerId: 'notification-test-worker-revoked',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('Delivery destination is unavailable');
      // Terminalize this isolated negative fixture so later recovery scans do
      // not count its abandoned claim once the one-second lease expires.
      await expect(
        store.completeDelivery({
          workspaceId: workspaceA,
          intentId: identity.intent_id,
          attemptNumber: claimed.attemptNumber,
          maxAttempts: 1,
          retryDelaySeconds: 0,
          result: {
            kind: 'definite_failure',
            safeErrorCode: 'provider.rejected',
            possiblyDispatched: false,
          },
        }),
      ).resolves.toBe('completed');
    } finally {
      await store.close();
    }
  });
}
