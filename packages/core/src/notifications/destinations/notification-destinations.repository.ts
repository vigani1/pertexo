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

import { FailureNotificationDestinationError } from './notification-destination.errors.js';

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

export async function readFailureNotificationDestination(
  client: PoolClient,
  workspaceId: string,
  destinationId: string,
  { lock = false }: Readonly<{ lock?: boolean | undefined }> = {},
): Promise<FailureNotificationDestinationRecord> {
  const db = drizzle(client);
  const predicate = and(
    eq(destination.workspaceId, workspaceId),
    eq(destination.id, destinationId),
  );
  if (lock) {
    const locked = await db
      .select({ id: destination.id })
      .from(destination)
      .where(predicate)
      .for('update')
      .catch(rethrowQueryFailure);
    if (locked.length !== 1)
      throw new FailureNotificationDestinationError(
        'not_found',
        'Destination is not visible',
      );
  }
  const [row] = await destinationRecords(db)
    .where(predicate)
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new FailureNotificationDestinationError(
      'not_found',
      'Destination is not visible',
    );
  return Object.freeze(row);
}
