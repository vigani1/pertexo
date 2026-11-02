import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  connections,
  connectionSecretVersions,
} from '@pertexo/database/schema';
import type { Role } from '@pertexo/workflow-model';

import {
  connectionScope,
  connectionScopeSql,
  type ConnectionCapability,
} from '../tenant-access/resources/connections/scope.js';
import type { ResourceActor } from '../shared/contract.js';
import { ConnectionNotFoundError, type ConnectionRecord } from './contract.js';

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

/** A restricted connection only exists for the members its shares and role reach. */
export async function requireVisibleConnection(
  client: PoolClient,
  actor: ResourceActor & Readonly<{ connectionId: string }>,
  role: Role,
  capability: ConnectionCapability,
): Promise<void> {
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
  if (found.length !== 1)
    throw new ConnectionNotFoundError('Connection is not visible');
}
