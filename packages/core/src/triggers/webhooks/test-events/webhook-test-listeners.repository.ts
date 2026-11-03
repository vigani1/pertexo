import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { webhookTestEvents as listeners } from '@pertexo/database/schema';
import type { PoolClient } from 'pg';

import type { TestEventScope } from './contract.js';

export const listenerSelection = {
  ...getTableColumns(listeners),
  expired: sql<boolean>`${listeners.expiresAt}<=clock_timestamp()`,
  databaseTime: sql<Date>`clock_timestamp()`.mapWith(listeners.createdAt),
};

/** A listener belongs to the person who started it. */
export async function lockListener(
  client: PoolClient,
  scope: TestEventScope,
  id: string,
) {
  const result = await drizzle(client)
    .select(listenerSelection)
    .from(listeners)
    .where(
      and(
        eq(listeners.workspaceId, scope.workspaceId),
        eq(listeners.workflowId, scope.workflowId),
        eq(listeners.nodeId, scope.nodeId),
        eq(listeners.createdBy, scope.actorId),
        eq(listeners.id, id),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return result[0];
}
