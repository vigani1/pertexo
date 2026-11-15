import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  connections,
  failureNotificationDestinations as destination,
  failureNotificationDestinationVersions as version,
} from '@pertexo/database/schema';
import { FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT } from '@pertexo/workflow-model';
import { and, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type {
  DestinationConfig,
  FailureNotificationDestinationRecord,
} from './notification-destination.types.js';
import { destinationRecords } from './notification-destinations.repository.js';

export async function listDestinations(
  client: PoolClient,
  workspaceId: string,
  afterId?: string,
): Promise<readonly FailureNotificationDestinationRecord[]> {
  const result = await destinationRecords(drizzle(client))
    .where(
      and(
        eq(destination.workspaceId, workspaceId),
        afterId === undefined ? undefined : gt(destination.id, afterId),
      ),
    )
    .orderBy(destination.id)
    .limit(FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT)
    .catch(rethrowQueryFailure);
  return Object.freeze(result.map((row) => Object.freeze(row)));
}

export async function insertDestination(
  client: PoolClient,
  input: Readonly<{
    destinationId: string;
    workspaceId: string;
    kind: DestinationConfig['kind'];
    actorId: string;
  }>,
): Promise<void> {
  await drizzle(client)
    .insert(destination)
    .values({
      id: input.destinationId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      status: 'enabled',
      currentConfigVersion: 1,
      createdBy: input.actorId,
    })
    .catch(rethrowQueryFailure);
}

export async function setCurrentDestinationVersion(
  client: PoolClient,
  workspaceId: string,
  destinationId: string,
  next: number,
): Promise<void> {
  await drizzle(client)
    .update(destination)
    .set({ currentConfigVersion: next, updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(destination.workspaceId, workspaceId),
        eq(destination.id, destinationId),
      ),
    )
    .catch(rethrowQueryFailure);
}

export async function updateDestinationStatus(
  client: PoolClient,
  workspaceId: string,
  destinationId: string,
  status: FailureNotificationDestinationRecord['status'],
): Promise<void> {
  await drizzle(client)
    .update(destination)
    .set({ status, updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(destination.workspaceId, workspaceId),
        eq(destination.id, destinationId),
      ),
    )
    .catch(rethrowQueryFailure);
}

/** Share-locks the active connection of the destination's provider, if any. */
export async function lockNotificationConnection(
  client: PoolClient,
  workspaceId: string,
  config: Exclude<DestinationConfig, { kind: 'system_mail' }>,
) {
  const result = await drizzle(client)
    .select({
      auth_type: connections.authType,
      provider_key: connections.providerKey,
      status: connections.status,
    })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, config.connectionId),
        eq(connections.status, 'active'),
        eq(connections.providerKey, config.kind),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  return result[0];
}

export async function insertVersion(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    destinationId: string;
    version: number;
    sideEffectClass: 'unsafe' | 'idempotent_with_key';
    config: DestinationConfig;
    actorId: string;
  }>,
): Promise<void> {
  const { kind, ...config } = input.config;
  await drizzle(client)
    .insert(version)
    .values({
      workspaceId: input.workspaceId,
      destinationId: input.destinationId,
      version: input.version,
      kind,
      sideEffectClass: input.sideEffectClass,
      config,
      createdBy: input.actorId,
    })
    .catch(rethrowQueryFailure);
}
