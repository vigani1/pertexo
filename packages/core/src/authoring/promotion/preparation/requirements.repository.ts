import {
  connectionScopeSql,
  type ConnectionScope,
} from '../../../shared/resources/connection-scope.repository.js';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { promotionConnection } from './source.repository.js';
import type { PoolClient } from 'pg';

export async function readPromotionConnections(
  client: PoolClient,
  workspaceId: string,
  scope: ConnectionScope,
  ids: string[],
) {
  const visible = connectionScopeSql(scope, promotionConnection);
  const rows = await drizzle(client)
    .select({
      id: promotionConnection.id,
      name: sql<
        string | null
      >`case when ${visible} then ${promotionConnection.name} else null end`,
      status: promotionConnection.status,
    })
    .from(promotionConnection)
    .where(
      and(
        eq(promotionConnection.workspaceId, workspaceId),
        inArray(promotionConnection.id, ids),
      ),
    )
    .orderBy(asc(promotionConnection.id))
    .for('share')
    .catch(rethrowQueryFailure);
  return rows;
}
