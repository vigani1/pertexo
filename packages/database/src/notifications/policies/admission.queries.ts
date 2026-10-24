import { and, eq, getTableName, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  workflowFailureNotificationPolicies as policy,
  failureNotificationDestinations as destinations,
  failureNotificationDestinationVersions as versions,
} from '../../schema/notifications.js';
import {
  connections,
  connectionSecretVersions,
} from '../../schema/connections.js';

import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';

type ResolvedFailureNotificationPolicy = Readonly<{
  destinationId: string;
  destinationConfigVersion: number;
  sideEffectClass: 'idempotent_with_key' | 'unsafe';
  connectionSecretVersionId: string;
}>;

export const notificationProviderRequirements = Object.freeze({
  email: Object.freeze({
    authType: 'resend_api_key',
    providerKey: 'email',
    sideEffectClass: 'idempotent_with_key',
  }),
  slack: Object.freeze({
    authType: 'slack_bot_token',
    providerKey: 'slack',
    sideEffectClass: 'unsafe',
  }),
} as const);

type NotificationKind = keyof typeof notificationProviderRequirements;

function eligibleNotificationDestination(
  destination:
    | Readonly<{
        connection_id: string | null;
        destination_status: string;
        kind: NotificationKind;
        side_effect_class: string;
      }>
    | undefined,
): destination is NonNullable<typeof destination> & { connection_id: string } {
  return (
    destination?.connection_id != null &&
    destination.destination_status === 'enabled' &&
    destination.side_effect_class ===
      notificationProviderRequirements[destination.kind].sideEffectClass
  );
}

function eligibleNotificationConnection(
  kind: NotificationKind,
  connection:
    | Readonly<{
        auth_type: string;
        provider_key: string;
        status: string;
      }>
    | undefined,
): connection is NonNullable<typeof connection> {
  const requirements = notificationProviderRequirements[kind];
  return (
    connection?.status === 'active' &&
    connection.provider_key === requirements.providerKey &&
    connection.auth_type === requirements.authType
  );
}

/** One notification policy resolver for ordinary run acceptance. */
export async function resolveWorkflowFailureNotificationPolicy(
  transaction: WorkspaceTransaction,
  workflowId: string,
): Promise<ResolvedFailureNotificationPolicy | undefined> {
  const [destination] = await transaction.db
    .select({
      connection_id: sql<
        string | null
      >`case when jsonb_typeof(${versions.config})='object' and ${versions.config} ? 'connectionId' and (${versions.config}->>'connectionId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then (${versions.config}->>'connectionId')::uuid end`,
      destination_id: destinations.id,
      current_config_version: destinations.currentConfigVersion,
      destination_status: destinations.status,
      side_effect_class: versions.sideEffectClass,
      kind: versions.kind,
    })
    .from(policy)
    .innerJoin(
      destinations,
      and(
        eq(destinations.workspaceId, policy.workspaceId),
        eq(destinations.id, policy.destinationId),
      ),
    )
    .innerJoin(
      versions,
      and(
        eq(versions.workspaceId, destinations.workspaceId),
        eq(versions.destinationId, destinations.id),
        eq(versions.version, destinations.currentConfigVersion),
      ),
    )
    .where(
      and(
        eq(policy.workspaceId, transaction.workspaceId),
        eq(policy.workflowId, workflowId),
      ),
    )
    .for('share', {
      of: [
        alias(policy, getTableName(policy)),
        alias(destinations, getTableName(destinations)),
      ],
    });
  if (!eligibleNotificationDestination(destination)) return undefined;

  const [connection] = await transaction.db
    .select({
      auth_type: connections.authType,
      current_secret_version_id: connections.currentSecretVersionId,
      provider_key: connections.providerKey,
      status: connections.status,
    })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, transaction.workspaceId),
        eq(connections.id, destination.connection_id),
      ),
    )
    .for('share');
  if (!eligibleNotificationConnection(destination.kind, connection))
    return undefined;

  const secret = await transaction.db
    .select({ id: connectionSecretVersions.id })
    .from(connectionSecretVersions)
    .where(
      and(
        eq(connectionSecretVersions.workspaceId, transaction.workspaceId),
        eq(connectionSecretVersions.connectionId, destination.connection_id),
        eq(connectionSecretVersions.id, connection.current_secret_version_id),
      ),
    );
  if (secret[0] === undefined) return undefined;

  return Object.freeze({
    destinationId: destination.destination_id,
    destinationConfigVersion: destination.current_config_version,
    sideEffectClass: destination.side_effect_class,
    connectionSecretVersionId: connection.current_secret_version_id,
  });
}
