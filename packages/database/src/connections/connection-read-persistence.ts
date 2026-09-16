import type { Pool } from 'pg';
import { z } from 'zod';

import { requireConnectionReader } from './connection-authority.js';
import {
  CONNECTION_STATUS,
  mapConnection,
  selectConnection,
  uuidSchema,
  withConnectionTransaction,
  type ConnectionPage,
  type ConnectionReadDatabase,
  type ListConnectionsInput,
} from './connection-persistence.js';

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
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionReader(client, workspaceId, actorId);
          const result = await client.query<
            Record<string, unknown> & { created_at_cursor: string }
          >(
            `select id, workspace_id, provider_key, name, auth_type, status,
                    current_secret_version_id, last_tested_at, last_healthy_at,
                    last_error_code, created_by, created_at, updated_at,
                    to_char(created_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_cursor
             from app.connections
             where workspace_id = $1
               and ($2::text is null
                 or status > $2::text
                 or (status = $2::text and created_at < $3::timestamptz)
                 or (status = $2::text and created_at = $3::timestamptz
                   and id > $4::uuid))
             order by status asc, created_at desc, id asc
             limit $5`,
            [
              workspaceId,
              after?.status ?? null,
              after?.createdAt ?? null,
              after?.id ?? null,
              limit + 1,
            ],
          );
          const hasMore = result.rows.length > limit;
          const items = Object.freeze(
            result.rows.slice(0, limit).map((row) => mapConnection(row)),
          );
          const last = result.rows.at(limit - 1);
          return Object.freeze({
            items,
            ...(hasMore && last !== undefined
              ? {
                  nextCursor: Object.freeze({
                    status: connectionStatusSchema.parse(last.status),
                    createdAt: connectionCursorTimestamp.parse(
                      last.created_at_cursor,
                    ),
                    id: uuidSchema.parse(last.id),
                  }),
                }
              : {}),
          });
        },
      );
    },
    readConnection: (input) => {
      const actorId = uuidSchema.parse(input.actorId);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionReader(client, workspaceId, actorId);
          return selectConnection(client, workspaceId, input.connectionId);
        },
      );
    },
  });
}
