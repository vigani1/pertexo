import type { ConnectionFence } from './contract.js';
import {
  rethrowQueryFailure,
  appendAuditFact,
} from '@pertexo/database/primitives';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaces,
  connections,
  connectionEvents,
} from '@pertexo/database/schema';
import type { PoolClient } from 'pg';

import { generatePersistedId } from '@pertexo/database/platform';

/**
 * Whether the secret may still be used: the workspace and the connection are
 * active and the connection still has this provider, auth type and current
 * secret. Holds both rows until the transaction ends.
 */
export async function isConnectionFenceCurrent(
  client: PoolClient,
  workspaceId: string,
  fence: ConnectionFence,
): Promise<boolean> {
  const db = drizzle(client);
  const workspace = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.status, 'active')))
    .for('share')
    .catch(rethrowQueryFailure);
  if (workspace.length !== 1) return false;
  const connection = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, fence.connectionId),
        eq(connections.providerKey, fence.providerKey),
        sql`${connections.authType}=${fence.authType}`,
        eq(connections.currentSecretVersionId, fence.secretVersionId),
        eq(connections.status, 'active'),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  return connection.length === 1;
}

/** Records that a worker read a connection's secret, and why. */
export async function recordCredentialAccess(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    connectionId: string;
    secretVersionId: string;
    workerId: string;
    traceId: string | null;
    purpose: string;
  }>,
): Promise<void> {
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    action: 'connection.credential_accessed',
    targetType: 'connection',
    targetId: input.connectionId,
    traceId: input.traceId,
    metadata: {
      actorKind: 'worker',
      purpose: input.purpose,
      secretVersionId: input.secretVersionId,
    },
  });
  await drizzle(client)
    .insert(connectionEvents)
    .values({
      id: generatePersistedId(),
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      eventType: 'connection.credential_accessed',
      actorKind: 'worker',
      actorId: input.workerId,
      traceId: input.traceId,
      metadata: {
        purpose: input.purpose,
        secretVersionId: input.secretVersionId,
      },
    })
    .catch(rethrowQueryFailure);
}
