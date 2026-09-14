import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { WorkspaceTransaction } from '../tenant-access/workspace.js';

type ResolvedFailureNotificationPolicy = Readonly<{
  policyVersion: 1;
  destinationId: string;
  destinationConfigVersion: number;
  sideEffectClass: 'idempotent_with_key' | 'unsafe';
  connectionSecretVersionId: string;
}>;

const notificationProviderRequirements = Object.freeze({
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

/** Acceptance-time resolver shared by manual, webhook, and schedule admission. */
export async function resolveWorkflowFailureNotificationPolicy(
  transaction: WorkspaceTransaction,
  workflowId: string,
): Promise<ResolvedFailureNotificationPolicy | undefined> {
  const destinationResult = await transaction.db.execute<{
    connection_id: string | null;
    destination_id: string;
    current_config_version: number;
    destination_status: string;
    side_effect_class: 'idempotent_with_key' | 'unsafe';
    kind: 'email' | 'slack';
  }>(sql`
    select * from app.lock_workflow_failure_notification_policy(
      ${transaction.workspaceId},${workflowId}
    )
  `);
  const destination = destinationResult.rows[0];
  if (!eligibleNotificationDestination(destination)) return undefined;

  const connectionResult = await transaction.db.execute<{
    auth_type: string;
    current_secret_version_id: string;
    provider_key: string;
    status: string;
  }>(sql`
    select connection.auth_type,
           connection.current_secret_version_id,
           connection.provider_key,
           connection.status
    from app.connections connection
    where connection.workspace_id = ${transaction.workspaceId}
      and connection.id = ${destination.connection_id}
    for share of connection
  `);
  const connection = connectionResult.rows[0];
  if (!eligibleNotificationConnection(destination.kind, connection))
    return undefined;

  const secretResult = await transaction.db.execute<{ id: string }>(sql`
    select secret.id
    from app.connection_secret_versions secret
    where secret.workspace_id = ${transaction.workspaceId}
      and secret.connection_id = ${destination.connection_id}
      and secret.id = ${connection.current_secret_version_id}
  `);
  if (secretResult.rows[0] === undefined) return undefined;

  return Object.freeze({
    policyVersion: 1,
    destinationId: z.uuid().parse(destination.destination_id),
    destinationConfigVersion: z
      .number()
      .int()
      .positive()
      .parse(destination.current_config_version),
    sideEffectClass: z
      .enum(['idempotent_with_key', 'unsafe'])
      .parse(destination.side_effect_class),
    connectionSecretVersionId: z
      .uuid()
      .parse(connection.current_secret_version_id),
  });
}
