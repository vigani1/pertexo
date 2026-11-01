import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  runFailureNotificationIntents as intent,
  failureNotificationDestinations as destination,
  failureNotificationDestinationVersions as version,
  connections as connection,
} from '@pertexo/database/schema';
import { notificationProviderRequirements } from '../policies/admission.queries.js';
import { destinationConfigSql } from '../destinations/records.queries.js';
export const currentDestinationSql = and(
  eq(destination.status, 'enabled'),
  eq(destination.kind, version.kind),
  eq(version.sideEffectClass, intent.sideEffectClass),
  eq(connection.providerKey, version.kind),
  sql`${connection.authType}=case ${version.kind} when 'slack' then ${notificationProviderRequirements.slack.authType} else ${notificationProviderRequirements.email.authType} end`,
  eq(connection.status, 'active'),
  eq(connection.currentSecretVersionId, intent.connectionSecretVersionId),
);
/** The immutable version and pinned credential are shared by loading and dispatch fencing. */
export function deliverySources(db: Pick<NodePgDatabase, 'select'>) {
  return db
    .select({
      config: destinationConfigSql.as('config'),
      secretVersionId: intent.connectionSecretVersionId,
    })
    .from(intent)
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
        eq(version.version, intent.destinationConfigVersion),
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
