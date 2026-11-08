import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  runFailureNotificationIntents as intent,
  failureNotificationDestinations as destination,
  failureNotificationDestinationVersions as version,
  connections as connection,
  workflows,
  workflowRuns,
} from '@pertexo/database/schema';
import { notificationProviderRequirements } from '../destinations/notification-policy.js';
import { destinationConfigSql } from '../destinations/notification-destinations.repository.js';
/**
 * An alert goes through the destination and credential in force when it's sent,
 * since a run can wait days and rotating a credential mustn't silence its alert.
 * The exception is a retry after a send that may have gone out: it stays on what
 * that send used, so the provider can recognise it, or fails if that has changed.
 * An intent from before these were recorded used what its run pinned.
 */
const deliveredVersion = sql<number>`case when ${intent.possiblyDispatched} then coalesce(${intent.dispatchedConfigVersion},${intent.destinationConfigVersion}) else ${destination.currentConfigVersion} end`;
const deliveredSecret = sql<string>`case when ${intent.possiblyDispatched} then coalesce(${intent.dispatchedSecretVersionId},${intent.connectionSecretVersionId}) else ${connection.currentSecretVersionId} end`;

export const currentDestinationSql = and(
  eq(destination.status, 'enabled'),
  eq(destination.kind, version.kind),
  eq(version.sideEffectClass, intent.sideEffectClass),
  eq(connection.providerKey, version.kind),
  sql`(${connection.authType}=case ${version.kind} when 'slack' then ${notificationProviderRequirements.slack.authType} else ${notificationProviderRequirements.email.authType} end or (${version.kind}='email' and ${connection.authType}='smtp' and ${version.sideEffectClass}='unsafe'))`,
  eq(connection.status, 'active'),
  eq(connection.currentSecretVersionId, deliveredSecret),
);
/** The version and credential a delivery uses, shared by loading and dispatch fencing. */
export function deliverySources(db: Pick<NodePgDatabase, 'select'>) {
  return db
    .select({
      workflowName: sql<string>`${workflows.name}`.as('workflow_name'),
      config: destinationConfigSql.as('config'),
      configVersion: deliveredVersion.as('config_version'),
      secretVersionId: deliveredSecret.as('secret_version_id'),
    })
    .from(intent)
    .innerJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, intent.workspaceId),
        eq(workflowRuns.id, intent.workflowRunId),
      ),
    )
    .innerJoin(
      workflows,
      and(
        eq(workflows.workspaceId, intent.workspaceId),
        eq(workflows.id, workflowRuns.workflowId),
      ),
    )
    .innerJoin(
      destination,
      and(
        eq(destination.workspaceId, intent.workspaceId),
        eq(destination.id, intent.destinationId),
      ),
    )
    .innerJoin(
      version,
      and(
        eq(version.workspaceId, intent.workspaceId),
        eq(version.destinationId, intent.destinationId),
        eq(version.version, deliveredVersion),
      ),
    )
    .innerJoin(
      connection,
      and(
        eq(connection.workspaceId, intent.workspaceId),
        eq(connection.id, sql`(${version.config}->>'connectionId')::uuid`),
      ),
    );
}
