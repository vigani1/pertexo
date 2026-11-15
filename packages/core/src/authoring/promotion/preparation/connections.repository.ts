import {
  connectionScopeSql,
  type ConnectionScope,
} from '../../../shared/resources/connection-scope.repository.js';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  promotionConnection,
  promotionConnectionProjection,
} from './source.repository.js';
import type { PoolClient } from 'pg';

/** The target's connections named like the source's, within the actor's connection scope. */
export async function shareLockTargetConnections(
  client: PoolClient,
  workspaceId: string,
  scope: ConnectionScope,
  names: readonly string[],
) {
  const targets = await drizzle(client)
    .select({
      ...promotionConnectionProjection,
      status: promotionConnection.status,
    })
    .from(promotionConnection)
    .where(
      and(
        eq(promotionConnection.workspaceId, workspaceId),
        inArray(sql`lower(${promotionConnection.name})`, [...names]),
        connectionScopeSql(scope, promotionConnection),
      ),
    )
    .orderBy(asc(promotionConnection.id))
    .for('share')
    .catch(rethrowQueryFailure);
  return targets;
}
