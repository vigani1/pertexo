import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { connections } from '@pertexo/database/schema';
import type { Role } from '@pertexo/workflow-model';

import {
  connectionScope,
  connectionScopeSql,
} from '../../tenant-access/resources/connections/scope.js';
import type {
  ConnectionPage,
  ConnectionRecord,
  ListConnectionsInput,
  ReadConnectionInput,
} from '../contract.js';
import { withOAuth2Facts } from '../oauth2/clients.repository.js';
import { connectionFields } from '../records.queries.js';

export const DEFAULT_CONNECTION_PAGE_SIZE = 50;

export async function listConnections(
  client: PoolClient,
  input: ListConnectionsInput,
  role: Role,
): Promise<ConnectionPage> {
  const { workspaceId, after } = input;
  const limit = input.limit ?? DEFAULT_CONNECTION_PAGE_SIZE;
  const result = await drizzle(client)
    .select({
      ...connectionFields,
      createdAtCursor: sql<string>`to_char(${connections.createdAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        connectionScopeSql(
          connectionScope(input, role, 'connection:read'),
          connections,
        ),
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
    ...(result.length > limit && last !== undefined
      ? {
          nextCursor: Object.freeze({
            status: last.status,
            createdAt: last.createdAtCursor,
            id: last.id,
          }),
        }
      : {}),
  });
}

export async function readConnection(
  client: PoolClient,
  input: ReadConnectionInput,
  role: Role,
): Promise<ConnectionRecord | null> {
  const { workspaceId } = input;
  const [row] = await drizzle(client)
    .select(connectionFields)
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, input.connectionId),
        connectionScopeSql(
          connectionScope(input, role, 'connection:read'),
          connections,
        ),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row === undefined) return null;
  const [record] = await withOAuth2Facts(client, workspaceId, [
    Object.freeze(row),
  ]);
  return record ?? null;
}
