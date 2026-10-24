import { rethrowQueryFailure } from '../../platform/query-errors.js';
import {
  connectionScope,
  connectionScopeSql,
} from '../../tenant-access/resources/connections/scope.js';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { connections } from '../../schema/connections.js';
import type { Pool } from 'pg';
import { z } from 'zod';

import { requireConnectionReader } from '../authority.queries.js';
import {
  CONNECTION_STATUS,
  type ConnectionPage,
  type ConnectionReadDatabase,
  type ListConnectionsInput,
} from '../contract.js';
import { connectionFields } from '../records.queries.js';
import { uuidSchema } from '../admission.js';
import { withConnectionTransaction } from '../transactions.repository.js';

const pageLimitSchema = z.number().int().positive().max(100);
const connectionStatusSchema = z.enum(CONNECTION_STATUS);
const connectionCursorTimestamp = z.iso
  .datetime({ precision: 6 })
  .refine((value) => !value.startsWith('0000-'), {
    message: 'PostgreSQL timestamps do not support year zero',
  });

function parseCursor(input: ListConnectionsInput['after']) {
  if (input === undefined) return undefined;
  return Object.freeze({
    status: connectionStatusSchema.parse(input.status),
    createdAt: connectionCursorTimestamp.parse(input.createdAt),
    id: uuidSchema.parse(input.id),
  });
}

export function createConnectionReadPersistence(
  pool: Pool,
): ConnectionReadDatabase {
  return Object.freeze({
    listConnections: (input): Promise<ConnectionPage> => {
      const actorId = uuidSchema.parse(input.actorId);
      const limit = pageLimitSchema.parse(input.limit ?? 50);
      const after = parseCursor(input.after);
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
                connectionScopeSql(scope, sql`${connections}`),
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
            result
              .slice(0, limit)
              .map(({ createdAtCursor: _cursor, ...record }) =>
                Object.freeze(record),
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
      const actorId = uuidSchema.parse(input.actorId);
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
                eq(connections.id, uuidSchema.parse(input.connectionId)),
                connectionScopeSql(scope, sql`${connections}`),
              ),
            )
            .catch(rethrowQueryFailure);
          return row === undefined ? null : Object.freeze(row);
        },
      });
    },
  });
}
