import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  connections,
  connectionSecretVersions as secrets,
  failureNotificationDestinations as destinations,
  failureNotificationDestinationVersions as versions,
  runFailureNotificationIntents as intents,
  workflowFailureNotificationPolicies as policy,
} from '@pertexo/database/schema';
import { and, desc, eq, getTableName, isNotNull, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import { destinationConnectionIdSql } from '../../notifications/policies/admission.queries.js';
import {
  failureAlertAttention,
  UNDELIVERED_ALERT_STATUSES,
} from './failure-alert-state.js';

/**
 * How long a failed alert keeps a destination in the Inbox with nothing newer to go
 * on. A week: long enough to be seen after a weekend, short enough that a one-off
 * doesn't sit there once the destination has simply had nothing to send.
 */
export const RECENT_ALERT_FAILURE_SQL = sql`interval '168 hours'`;

type Subject = Readonly<{ workspaceId: string; subjectId: string }>;

/** A destination's current facts; the rule itself is in `failure-alert-state.ts`. */
export async function readFailureAlertState(
  client: PoolClient,
  { workspaceId, subjectId }: Subject,
) {
  const db = drizzle(client);
  const [destination] = await db
    .select({
      connection_id: destinationConnectionIdSql(versions),
      destination_status: destinations.status,
      side_effect_class: versions.sideEffectClass,
      kind: versions.kind,
      current_config_version: destinations.currentConfigVersion,
    })
    .from(destinations)
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
        eq(destinations.workspaceId, workspaceId),
        eq(destinations.id, subjectId),
      ),
    )
    .for('share', { of: alias(destinations, getTableName(destinations)) })
    .catch(rethrowQueryFailure);
  if (destination === undefined) return null;
  const connectionId = destination.connection_id;
  const [connection] =
    connectionId === null
      ? []
      : await db
          .select({
            auth_type: connections.authType,
            provider_key: connections.providerKey,
            status: connections.status,
            current_secret_version_id: connections.currentSecretVersionId,
            secret_exists: sql<boolean>`${secrets.id} is not null`,
          })
          .from(connections)
          .leftJoin(
            secrets,
            and(
              eq(secrets.workspaceId, connections.workspaceId),
              eq(secrets.connectionId, connections.id),
              eq(secrets.id, connections.currentSecretVersionId),
            ),
          )
          .where(
            and(
              eq(connections.workspaceId, workspaceId),
              eq(connections.id, connectionId),
            ),
          )
          .catch(rethrowQueryFailure);
  const policies = await db
    .select({ one: sql`1` })
    .from(policy)
    .where(
      and(
        eq(policy.workspaceId, workspaceId),
        eq(policy.destinationId, subjectId),
      ),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  return failureAlertAttention({
    destination,
    connection,
    hasPolicy: policies.length > 0,
    latestAlertUndelivered: await latestAlertUndelivered(db, {
      workspaceId,
      subjectId,
      connectionId,
    }),
  });
}

async function latestAlertUndelivered(
  db: Pick<NodePgDatabase, 'select'>,
  {
    workspaceId,
    subjectId,
    connectionId,
  }: Subject & Readonly<{ connectionId: string | null }>,
): Promise<boolean> {
  const [latest] = await db
    .select({
      undelivered: sql<boolean>`(
        ${intents.status} in (${sql.join(
          UNDELIVERED_ALERT_STATUSES.map((status) => sql`${status}`),
          sql`,`,
        )})
        and ${intents.completedAt}>clock_timestamp()-${RECENT_ALERT_FAILURE_SQL}
        and ${intents.completedAt}>${destinations.updatedAt}
        and ${intents.completedAt}>coalesce(${connections.lastHealthTransitionAt},'-infinity')
        and ${intents.completedAt}>coalesce(${secrets.createdAt},'-infinity')
      )`,
    })
    .from(intents)
    .innerJoin(
      destinations,
      and(
        eq(destinations.workspaceId, intents.workspaceId),
        eq(destinations.id, intents.destinationId),
      ),
    )
    .leftJoin(
      connections,
      and(
        eq(connections.workspaceId, intents.workspaceId),
        eq(connections.id, sql`${connectionId}::uuid`),
      ),
    )
    .leftJoin(
      secrets,
      and(
        eq(secrets.workspaceId, connections.workspaceId),
        eq(secrets.id, connections.currentSecretVersionId),
      ),
    )
    .where(
      and(
        eq(intents.workspaceId, workspaceId),
        eq(intents.destinationId, subjectId),
        isNotNull(intents.completedAt),
      ),
    )
    .orderBy(desc(intents.completedAt), desc(intents.id))
    .limit(1)
    .catch(rethrowQueryFailure);
  return latest?.undelivered ?? false;
}
