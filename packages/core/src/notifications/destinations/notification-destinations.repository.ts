import type { FailureNotificationDestinationConfig } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  failureNotificationDestinations as destination,
  failureNotificationDestinationVersions as version,
} from '@pertexo/database/schema';
import type { FailureNotificationDestinationRecord } from './notification-destination.types.js';

/** The FK and strict JSON check correlate the canonical kind with its config. */
export const destinationConfigSql = sql<FailureNotificationDestinationConfig>`${version.config} || jsonb_build_object('kind',${version.kind})`;
export function destinationRecords(db: Pick<NodePgDatabase, 'select'>) {
  return db
    .select({
      id: destination.id,
      workspaceId: destination.workspaceId,
      kind: destination.kind,
      status: destination.status,
      currentVersion: destination.currentConfigVersion,
      config: destinationConfigSql,
      createdAt: sql<Date>`${destination.createdAt}`.mapWith(
        (value: string) => new Date(value),
      ),
      updatedAt: sql<Date>`${destination.updatedAt}`.mapWith(
        (value: string) => new Date(value),
      ),
    })
    .from(destination)
    .innerJoin(
      version,
      and(
        eq(version.workspaceId, destination.workspaceId),
        eq(version.destinationId, destination.id),
        eq(version.version, destination.currentConfigVersion),
      ),
    );
}

/** Locks the destination row; false when it isn't visible. */
export async function lockDestination(
  client: PoolClient,
  workspaceId: string,
  destinationId: string,
): Promise<boolean> {
  const locked = await drizzle(client)
    .select({ id: destination.id })
    .from(destination)
    .where(destinationKey(workspaceId, destinationId))
    .for('update')
    .catch(rethrowQueryFailure);
  return locked.length === 1;
}

export async function readDestinationRecord(
  client: PoolClient,
  workspaceId: string,
  destinationId: string,
): Promise<FailureNotificationDestinationRecord | undefined> {
  const [row] = await destinationRecords(drizzle(client))
    .where(destinationKey(workspaceId, destinationId))
    .catch(rethrowQueryFailure);
  return row === undefined ? undefined : Object.freeze(row);
}

function destinationKey(workspaceId: string, destinationId: string) {
  return and(
    eq(destination.workspaceId, workspaceId),
    eq(destination.id, destinationId),
  );
}
