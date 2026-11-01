import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { connections } from '@pertexo/database/schema';
import {
  connectionScope,
  connectionScopeSql,
} from '../../tenant-access/resources/connections/scope.js';

import { requireConnectionReader } from '../authority.queries.js';
import type { ConnectionPage, ConnectionReadDatabase } from '../contract.js';
import { connectionFields } from '../records.queries.js';
import { withOAuth2Facts } from '../oauth2/clients.repository.js';
import { withConnectionTransaction } from '../transaction.js';

export function createConnectionReadPersistence(
  pool: Pool,
): ConnectionReadDatabase {
  return Object.freeze({
    listConnections: (input): Promise<ConnectionPage> => {
      const actorId = input.actorId;
      const limit = input.limit ?? 50;
      const after = input.after;
      return withConnectionTransaction(pool, input.workspaceId, {
        actorId,
        operation: async (client, workspaceId) => {
          const role = await requireConnectionReader(
            client,
            workspaceId,
            actorId,
          );
          const scope = connectionScope(
            { workspaceId, actorId },
            role,
            'connection:read',
          );
          const result = await drizzle(client)
            .select({
              ...connectionFields,
              createdAtCursor: sql<string>`to_char(${connections.createdAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
            })
            .from(connections)
            .where(
              and(
                eq(connections.workspaceId, workspaceId),
                connectionScopeSql(scope, connections),
                after === undefined
                  ? undefined
                  : sql`(${connections.status}>${after.status}::text or (${connections.status}=${after.status}::text and ${connections.createdAt}<${after.createdAt}::timestamptz) or (${connections.status}=${after.status}::text and ${connections.createdAt}=${after.createdAt}::timestamptz and ${connections.id}>${after.id}::uuid))`,
              ),
            )
            .orderBy(
              asc(connections.status),
              desc(connections.createdAt),
              asc(connections.id),
            )
            .limit(limit + 1)
            .catch(rethrowQueryFailure);
          const hasMore = result.length > limit;
          const items = Object.freeze(
            await withOAuth2Facts(
              client,
              workspaceId,
              result
                .slice(0, limit)
                .map(({ createdAtCursor: _cursor, ...record }) =>
                  Object.freeze(record),
                ),
            ),
          );
          const last = result.at(limit - 1);
          return Object.freeze({
            items,
            ...(hasMore && last !== undefined
              ? {
                  nextCursor: Object.freeze({
                    status: last.status,
                    createdAt: last.createdAtCursor,
                    id: last.id,
                  }),
                }
              : {}),
          });
        },
      });
    },
    readConnection: (input) => {
      const actorId = input.actorId;
      return withConnectionTransaction(pool, input.workspaceId, {
        actorId,
        operation: async (client, workspaceId) => {
          const role = await requireConnectionReader(
            client,
            workspaceId,
            actorId,
          );
          const scope = connectionScope(
            { workspaceId, actorId },
            role,
            'connection:read',
          );
          const [row] = await drizzle(client)
            .select(connectionFields)
            .from(connections)
            .where(
              and(
                eq(connections.workspaceId, workspaceId),
                eq(connections.id, input.connectionId),
                connectionScopeSql(scope, connections),
              ),
            )
            .catch(rethrowQueryFailure);
          if (row === undefined) return null;
          const [record] = await withOAuth2Facts(client, workspaceId, [
            Object.freeze(row),
          ]);
          return record ?? null;
        },
      });
    },
  });
}
