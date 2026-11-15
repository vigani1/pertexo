import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  connections,
  connectionSecretVersions,
} from '@pertexo/database/schema';
import type { Role } from '@pertexo/policy';

import {
  connectionScope,
  connectionScopeSql,
  type ConnectionCapability,
} from '../shared/resources/connection-scope.repository.js';
import type { ResourceActor } from '../shared/folder-access.types.js';
import type { ConnectionRecord } from './connection.types.js';

export const connectionFields = {
  id: connections.id,
  workspaceId: connections.workspaceId,
  providerKey: connections.providerKey,
  name: connections.name,
  authType: connections.authType,
  status: connections.status,
  currentSecretVersionId: connections.currentSecretVersionId,
  lastTestedAt: connections.lastTestedAt,
  lastHealthyAt: connections.lastHealthyAt,
  lastErrorCode: connections.lastErrorCode,
  lastRunObservedAt: connections.lastRunObservedAt,
  lastHealthTransitionAt: connections.lastHealthTransitionAt,
  lastHealthTransitionSource: connections.lastHealthTransitionSource,
  createdBy: connections.createdBy,
  createdAt: connections.createdAt,
  updatedAt: connections.updatedAt,
  accessMode: connections.accessMode,
};
export const sealedFields = {
  kmsKeyReference: connectionSecretVersions.kmsKeyReference,
  encryptedDataKey: connectionSecretVersions.encryptedDataKey,
  ciphertext: connectionSecretVersions.ciphertext,
  nonce: connectionSecretVersions.nonce,
  tag: connectionSecretVersions.authTag,
};

export async function selectConnection(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
  { lock = false }: Readonly<{ lock?: boolean | undefined }> = {},
): Promise<ConnectionRecord | null> {
  const query = drizzle(client)
    .select(connectionFields)
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, connectionId),
      ),
    )
    .$dynamic();
  const [row] = await (lock ? query.for('update') : query).catch(
    rethrowQueryFailure,
  );
  return row === undefined ? null : Object.freeze(row);
}

/** Whether the connection exists for this member: a restricted one only for those its shares and role reach. */
export async function connectionVisible(
  client: PoolClient,
  actor: ResourceActor & Readonly<{ connectionId: string }>,
  role: Role,
  capability: ConnectionCapability,
): Promise<boolean> {
  const found = await drizzle(client)
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, actor.workspaceId),
        eq(connections.id, actor.connectionId),
        connectionScopeSql(
          connectionScope(actor, role, capability),
          connections,
        ),
      ),
    )
    .catch(rethrowQueryFailure);
  return found.length === 1;
}
