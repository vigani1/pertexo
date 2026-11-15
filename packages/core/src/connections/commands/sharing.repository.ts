import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  connections,
  connectionShares,
  users,
  workspaceMemberships,
} from '@pertexo/database/schema';
import { CONNECTION_SHARE_LIMIT } from '@pertexo/workflow-model';
import type { ReplaceConnectionSharingInput } from './connection-sharing.types.js';

type ConnectionKey = Readonly<{ workspaceId: string; connectionId: string }>;

export async function readSharingMode(
  client: PoolClient,
  { workspaceId, connectionId }: ConnectionKey,
) {
  const db = drizzle(client);
  const [row] = await db
    .select({
      accessMode: connections.accessMode,
      sharingRevision: connections.sharingRevision,
    })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, connectionId),
      ),
    )
    .catch(rethrowQueryFailure);
  return row;
}

/** The shares in user order, one past the cap so an overfull set shows. */
export async function readShareMembers(
  client: PoolClient,
  { workspaceId, connectionId }: ConnectionKey,
) {
  const db = drizzle(client);
  const members = await db
    .select({
      userId: connectionShares.userId,
      label: users.displayName,
      active: sql<boolean>`(${workspaceMemberships.status}='active' and ${users.status}='active')`,
    })
    .from(connectionShares)
    .innerJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, connectionShares.workspaceId),
        eq(workspaceMemberships.userId, connectionShares.userId),
      ),
    )
    .innerJoin(users, eq(users.id, workspaceMemberships.userId))
    .where(
      and(
        eq(connectionShares.workspaceId, workspaceId),
        eq(connectionShares.connectionId, connectionId),
      ),
    )
    .orderBy(connectionShares.userId)
    .limit(CONNECTION_SHARE_LIMIT + 1)
    .catch(rethrowQueryFailure);
  return members;
}

/** How many of the requested users are active members. */
export async function countActiveMembers(
  client: PoolClient,
  workspaceId: string,
  userIds: readonly string[],
): Promise<number> {
  const db = drizzle(client);
  const members = await db
    .select({ userId: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .innerJoin(
      users,
      and(
        eq(users.id, workspaceMemberships.userId),
        eq(users.status, 'active'),
      ),
    )
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        inArray(workspaceMemberships.userId, [...userIds]),
        eq(workspaceMemberships.status, 'active'),
      ),
    )
    .catch(rethrowQueryFailure);
  return members.length;
}

/** Replaces the shares and mode, moving the sharing revision on. */
export async function replaceShares(
  client: PoolClient,
  { workspaceId, connectionId }: ConnectionKey,
  request: ReplaceConnectionSharingInput['request'],
): Promise<void> {
  const db = drizzle(client);
  await db
    .delete(connectionShares)
    .where(
      and(
        eq(connectionShares.workspaceId, workspaceId),
        eq(connectionShares.connectionId, connectionId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (request.userIds.length > 0)
    await db
      .insert(connectionShares)
      .values(
        request.userIds.map((userId) => ({
          workspaceId,
          connectionId,
          userId,
        })),
      )
      .catch(rethrowQueryFailure);
  await db
    .update(connections)
    .set({
      accessMode: request.mode,
      sharingRevision: sql`${connections.sharingRevision}+1`,
    })
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, connectionId),
      ),
    )
    .catch(rethrowQueryFailure);
}
