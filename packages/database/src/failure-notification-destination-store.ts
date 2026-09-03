import type { Pool } from 'pg';
import { z } from 'zod';
import { FailureNotificationDestinationConfigSchema } from '@pertexo/workflow-model/failure-notification';

import { FailureNotificationStateError } from './failure-notification-errors.js';
import { generatePersistedId } from './persisted-id.js';
import {
  auditFailureNotification,
  failureNotificationIdentitySchema,
} from './failure-notification-store-support.js';
import type {
  FailureNotificationResolvedDestination,
  FailureNotificationStore,
} from './failure-notifications.js';
import { withTenantScopedClient } from './tenant-access/workspace.js';

type DestinationStore = Pick<
  FailureNotificationStore,
  'fenceDispatch' | 'loadDestination'
>;

export function createFailureNotificationDestinationStore(
  pool: Pool,
): DestinationStore {
  return Object.freeze({
    loadDestination: async (
      raw: Parameters<FailureNotificationStore['loadDestination']>[0],
    ): Promise<FailureNotificationResolvedDestination> => {
      const workspaceId = failureNotificationIdentitySchema.parse(
        raw.workspaceId,
      );
      const intentId = failureNotificationIdentitySchema.parse(raw.intentId);
      const workerId = z.string().min(1).max(128).parse(raw.workerId);
      return withTenantScopedClient(
        pool,
        { workspaceId },
        async (client) => {
          const result = await client.query<Record<string, unknown>>(
            `select version.kind, version.config, intent.connection_secret_version_id,
                  secret.schema_version, secret.kms_key_reference,
                  secret.encrypted_data_key, secret.ciphertext, secret.nonce,
                  secret.auth_tag
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
              where intent.workspace_id=$1 and intent.id=$2
                and intent.status='claimed' and intent.delivery_attempts=$3
                and destination.status='enabled'
                and destination.kind=version.kind
               and version.side_effect_class=intent.side_effect_class
               and connection.provider_key=version.kind
               and connection.auth_type=case version.kind
                 when 'slack' then 'slack_bot_token' else 'resend_api_key' end
               and connection.status='active'
              and connection.current_secret_version_id=intent.connection_secret_version_id`,
            [workspaceId, intentId, raw.attemptNumber],
          );
          const row = result.rows[0];
          if (row === undefined)
            throw new FailureNotificationStateError(
              'Delivery destination is unavailable',
            );
          const kind = z.enum(['slack', 'email']).parse(row.kind);
          const config = FailureNotificationDestinationConfigSchema.parse({
            ...z.record(z.string(), z.unknown()).parse(row.config),
            kind,
          });
          const connectionId = config.connectionId;
          const secretVersionId = failureNotificationIdentitySchema.parse(
            row.connection_secret_version_id,
          );
          await client.query(
            `insert into app.connection_events
             (id,workspace_id,connection_id,event_type,actor_kind,actor_id,metadata)
           values ($1,$2,$3,'connection.credential_accessed','worker',$4,$5::jsonb)`,
            [
              generatePersistedId(),
              workspaceId,
              connectionId,
              workerId,
              JSON.stringify({
                purpose: 'failure_notification.deliver',
                secretVersionId,
              }),
            ],
          );
          const resolved = {
            connectionId,
            secretVersionId,
            sealed: Object.freeze({
              schemaVersion: z.literal(1).parse(row.schema_version),
              kmsKeyReference: z.string().parse(row.kms_key_reference),
              encryptedDataKey: z.string().parse(row.encrypted_data_key),
              ciphertext: z.string().parse(row.ciphertext),
              nonce: z.string().parse(row.nonce),
              tag: z.string().parse(row.auth_tag),
            }),
          };
          return config.kind === 'slack'
            ? Object.freeze({
                ...resolved,
                kind: config.kind,
                channelId: config.channelId,
              })
            : Object.freeze({
                ...resolved,
                kind: config.kind,
                toEmail: config.toEmail,
              });
        },
        { signal: raw.signal, statementTimeoutMillis: 30_000 },
      );
    },
    fenceDispatch: async (
      raw: Parameters<FailureNotificationStore['fenceDispatch']>[0],
    ): Promise<void> => {
      const workspaceId = failureNotificationIdentitySchema.parse(
        raw.workspaceId,
      );
      const intentId = failureNotificationIdentitySchema.parse(raw.intentId);
      await withTenantScopedClient(pool, { workspaceId }, async (client) => {
        const parsedBinding =
          raw.deliveryBinding === undefined
            ? null
            : z
                .string()
                .regex(/^email:v1:sha256:[0-9a-f]{64}$/u)
                .parse(raw.deliveryBinding);
        const destination = await client.query<{ ready: boolean }>(
          `select app.lock_failure_notification_dispatch_destination($1,$2,$3) ready`,
          [workspaceId, intentId, raw.attemptNumber],
        );
        if (destination.rows[0]?.ready !== true)
          throw new FailureNotificationStateError(
            'Delivery dispatch fence failed',
          );
        const fenced = await client.query(
          `update app.run_failure_notification_intents intent
              set status='dispatching',dispatch_marked_at=clock_timestamp(),
                  delivery_binding=coalesce(intent.delivery_binding,$4),
                  updated_at=clock_timestamp()
             from app.failure_notification_destinations destination,
                  app.failure_notification_destination_versions version,
                  app.connections connection
            where intent.workspace_id=$1 and intent.id=$2
              and intent.status='claimed' and intent.delivery_attempts=$3
               and destination.workspace_id=intent.workspace_id
               and destination.id=intent.destination_id
               and destination.status='enabled'
               and destination.kind=version.kind
              and version.workspace_id=intent.workspace_id
              and version.destination_id=intent.destination_id
              and version.version=intent.destination_config_version
              and version.side_effect_class=intent.side_effect_class
              and connection.workspace_id=intent.workspace_id
              and connection.id=(version.config->>'connectionId')::uuid
              and connection.provider_key=version.kind
              and connection.auth_type=case version.kind
                when 'slack' then 'slack_bot_token' else 'resend_api_key' end
              and connection.status='active'
              and connection.current_secret_version_id=intent.connection_secret_version_id
              and (($4::text is null and intent.delivery_binding is null)
                or ($4 is not null and (intent.delivery_binding is null or intent.delivery_binding=$4)))
              and app.connection_dispatch_fence_current(
                intent.workspace_id,connection.id,version.kind,
                case version.kind when 'slack' then 'slack_bot_token' else 'resend_api_key' end,
                intent.connection_secret_version_id)
            returning intent.id`,
          [workspaceId, intentId, raw.attemptNumber, parsedBinding],
        );
        if (fenced.rowCount !== 1)
          throw new FailureNotificationStateError(
            'Delivery dispatch fence failed',
          );
        await auditFailureNotification(client, {
          workspaceId,
          intentId,
          factType: 'dispatch_marked',
          attemptNumber: raw.attemptNumber,
          possiblyDispatched: false,
        });
      });
    },
  });
}
