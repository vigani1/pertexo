import {
  canonicalOutboxPayloadChecksum,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { createOutboxDispatcherDatabase } from '@pertexo/core/testing';

import { expect } from 'vitest';
import { createProviderFailureNotificationDelivery } from '../../../../../src/notifications/failure-delivery.js';

import {
  databaseUrl,
  dispatcherUrl,
  startService,
  stopService,
  workerQuery,
  workspaceId,
} from '../fixture.js';
import type {
  FailureNotificationScenario,
  FailureProofStore,
} from './contract.js';

export async function assertPostgresLossBeforeFence(
  scenario: FailureNotificationScenario,
  store: FailureProofStore,
) {
  const {
    secretVersionId,
    intentId,
    initialOutboxEventId,
    initialPayload,
    slackIntentId,
    slackOutboxEventId,
    slackPayload,
  } = scenario;
  const initialClaim = await store.claimDelivery({
    workspaceId,
    intentId,
    delivery: {
      outboxEventId: initialOutboxEventId,
      payloadChecksum: canonicalOutboxPayloadChecksum(initialPayload),
    },
    recoverySeconds: 1,
    maxAttempts: 3,
  });
  expect(initialClaim).toMatchObject({ kind: 'ready', attemptNumber: 1 });
  const slackClaim = await store.claimDelivery({
    workspaceId,
    intentId: slackIntentId,
    delivery: {
      outboxEventId: slackOutboxEventId,
      payloadChecksum: canonicalOutboxPayloadChecksum(slackPayload),
    },
    recoverySeconds: 1,
    maxAttempts: 3,
  });
  expect(slackClaim).toMatchObject({ kind: 'ready', attemptNumber: 1 });
  const destinationProof = await workerQuery<{
    auth_type: string;
    connection_status: string;
    current_secret_version_id: string;
    destination_kind: string;
    intent_secret_version_id: string;
    provider_key: string;
    secret_id: string;
    version_kind: string;
  }>(
    `select destination.kind destination_kind,version.kind version_kind,
                  connection.provider_key,connection.auth_type,
                  connection.status connection_status,
                  connection.current_secret_version_id,
                  intent.connection_secret_version_id intent_secret_version_id,
                  secret.id secret_id
             from app.run_failure_notification_intents intent
             join app.failure_notification_destinations destination
               on destination.workspace_id=intent.workspace_id
              and destination.id=intent.destination_id
             join app.failure_notification_destination_versions version
               on version.workspace_id=intent.workspace_id
              and version.destination_id=intent.destination_id
              and version.version=intent.destination_config_version
             join app.connections connection
               on connection.workspace_id=intent.workspace_id
              and connection.id=(version.config->>'connectionId')::uuid
             join app.connection_secret_versions secret
               on secret.workspace_id=connection.workspace_id
              and secret.connection_id=connection.id
              and secret.id=intent.connection_secret_version_id
            where intent.workspace_id=$1 and intent.id=$2`,
    [workspaceId, intentId],
  );
  expect(destinationProof).toEqual([
    {
      destination_kind: 'email',
      version_kind: 'email',
      provider_key: 'email',
      secret_id: secretVersionId,
      auth_type: 'resend_api_key',
      connection_status: 'active',
      current_secret_version_id: secretVersionId,
      intent_secret_version_id: secretVersionId,
    },
  ]);
  if (initialClaim.kind !== 'ready' || slackClaim.kind !== 'ready')
    throw new Error('destructive destination claims were not ready');
  const preFenceProviderCalls: string[] = [];
  const preFenceDelivery = createProviderFailureNotificationDelivery({
    store,
    encryption: {
      open: () =>
        Promise.reject(
          new Error('PostgreSQL loss must fail before credential opening'),
        ),
    },
    slack: {
      sendMessage: () => {
        preFenceProviderCalls.push('slack');
        return Promise.resolve({
          kind: 'succeeded',
          channelId: 'unexpected',
          messageTs: 'unexpected',
        });
      },
    },
    email: {
      sendNotification: () => {
        preFenceProviderCalls.push('email');
        return Promise.resolve({
          kind: 'succeeded',
          emailId: 'unexpected',
        });
      },
    },
    workerId: 'failure-notification-postgres-loss',
  });
  const readinessDatabase = createOutboxDispatcherDatabase(
    parseDatabaseConfig({
      connectionString: databaseUrl(dispatcherUrl),
      connectionTimeoutMillis: 1_000,
      max: 1,
    }),
  );
  try {
    await stopService('postgres');
    await expect(readinessDatabase.checkReadiness()).rejects.toThrow();
    for (const [claim, claimedIntentId] of [
      [initialClaim, intentId],
      [slackClaim, slackIntentId],
    ] as const) {
      await expect(
        preFenceDelivery.deliver({
          context: claim.context,
          workspaceId,
          intentId: claimedIntentId,
          attemptNumber: claim.attemptNumber,
          destinationId: claim.destinationId,
          destinationConfigVersion: claim.destinationConfigVersion,
          idempotencyKey: claim.idempotencyKey,
          sideEffectClass: claim.sideEffectClass,
          connectionSecretVersionId: claim.connectionSecretVersionId,
          deliveryUnresolved: claim.deliveryUnresolved,
          ...(claim.deliveryBinding === undefined
            ? {}
            : { deliveryBinding: claim.deliveryBinding }),
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        kind: 'retry',
        possiblyDispatched: false,
      });
    }
    expect(preFenceProviderCalls).toEqual([]);
  } finally {
    await startService('postgres');
    await readinessDatabase.close();
  }
  await workerQuery(
    `update app.run_failure_notification_intents
              set recovery_at=clock_timestamp()-interval '1 second'
            where workspace_id=$1 and id=any($2::uuid[])`,
    [workspaceId, [intentId, slackIntentId]],
  );
  await expect(store.recoverDue(10, 3)).resolves.toBe(2);
  await expect(
    workerQuery<{ possibly_dispatched: boolean; status: string }>(
      `select status,possibly_dispatched
               from app.run_failure_notification_intents
              where workspace_id=$1 and id=any($2::uuid[]) order by id`,
      [workspaceId, [intentId, slackIntentId]],
    ),
  ).resolves.toEqual([
    { status: 'retry', possibly_dispatched: false },
    { status: 'retry', possibly_dispatched: false },
  ]);
}
