import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  rethrowQueryFailure,
  appendAuditFact,
  canonicalOutboxPayloadChecksum,
  claimCommand,
  completeCommand,
} from '@pertexo/database/primitives';
import {
  connections,
  connectionShares,
  users,
  workspaceMemberships,
} from '@pertexo/database/schema';
import type {
  ReadConnectionSharingInput,
  ReplaceConnectionSharingInput,
} from './contract.js';

import { CONNECTION_SHARE_LIMIT } from '@pertexo/workflow-model';
import type { ConnectionSharing } from '@pertexo/contracts';

import {
  ConnectionNotFoundError,
  ConnectionSharingCorruptError,
  ConnectionSharingRevisionConflictError,
} from '../contract.js';
import { connectionCommand, connectionCommandScope } from '../receipts.js';

async function readSharing(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionSharing> {
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
  if (row === undefined)
    throw new ConnectionNotFoundError('Connection is not visible');
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
  if (members.length > CONNECTION_SHARE_LIMIT)
    throw new ConnectionSharingCorruptError();
  return {
    connectionId,
    mode: row.accessMode,
    revision: row.sharingRevision,
    members,
  };
}

export function readConnectionSharing(
  client: PoolClient,
  input: ReadConnectionSharingInput,
): Promise<ConnectionSharing> {
  return readSharing(client, input.workspaceId, input.connectionId);
}

export async function replaceConnectionSharing(
  client: PoolClient,
  input: ReplaceConnectionSharingInput,
): Promise<ConnectionSharing & { replayed: boolean }> {
  const { workspaceId, actorId, connectionId, request } = input;
  const db = drizzle(client);
  const current = await readSharing(client, workspaceId, connectionId);
  const command = connectionCommand(
    {
      idempotencyKey: input.idempotencyKey,
      requestHash: canonicalOutboxPayloadChecksum(request),
    },
    workspaceId,
    'connection.sharing',
    connectionCommandScope(actorId, connectionId),
  );
  const replay = await claimCommand<ConnectionSharing>(client, {
    ...command,
    resourceId: connectionId,
  });
  if (replay !== null) return { ...replay, replayed: true };
  if (current.revision !== request.expectedSharingRevision)
    throw new ConnectionSharingRevisionConflictError();
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
        inArray(workspaceMemberships.userId, [...request.userIds]),
        eq(workspaceMemberships.status, 'active'),
      ),
    )
    .catch(rethrowQueryFailure);
  if (members.length !== request.userIds.length)
    throw new ConnectionNotFoundError('A sharing member is unavailable');
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
  const result = await readSharing(client, workspaceId, connectionId);
  await appendAuditFact(client, {
    workspaceId,
    actorId,
    action: 'connection.sharing_changed',
    targetType: 'connection',
    targetId: connectionId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata: {
      mode: request.mode,
      revision: result.revision,
      members: request.userIds.length,
      previousShares: canonicalOutboxPayloadChecksum(
        current.members.map((member) => member.userId),
      ),
      shares: canonicalOutboxPayloadChecksum([...request.userIds].sort()),
    },
  });
  await completeCommand(client, command, result);
  return { ...result, replayed: false };
}
