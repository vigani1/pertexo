import type { Pool, PoolClient } from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  connections,
  connectionSecretVersions,
} from '../schema/connections.js';
import { rethrowQueryFailure } from '../platform/query-errors.js';

import { withTenantScopedClient } from '../tenant-access/transactions.js';
import type { WorkspaceTransactionOptions } from '../tenant-access/transactions.js';
import type { ConnectionRecord } from './contract.js';
import { uuidSchema, identifierSchema } from './admission.js';

export {
  CONNECTION_STATUS,
  type ConnectionStatus,
  CONNECTION_AUTH_TYPE,
  type ConnectionAuthType,
  CONNECTION_EVENT_TYPE,
  type SealedConnectionSecretRecord,
  type ConnectionRecord,
  type ListConnectionsInput,
  type ConnectionPage,
  type ReadConnectionInput,
  type ResolvedConnectionSecretRecord,
  type RequestMetadata,
  type CreateConnectionInput,
  type FindConnectionCreateReplayInput,
  type FindConnectionRotateReplayInput,
  type RotateConnectionSecretInput,
  type RevokeConnectionInput,
  type ResolveConnectionSecretInput,
  type AssertConnectionSecretCurrentInput,
  type ConnectionTestOutcome,
  type ConnectionTestResult,
  type StartConnectionTestInput,
  type StartConnectionTestResult,
  type ResolveConnectionTestSecretInput,
  type MarkConnectionTestDispatchedInput,
  type CompleteConnectionTestInput,
  type AbandonConnectionTestInput,
  type ConnectionDatabase,
  type ConnectionManagementDatabase,
  type ConnectionReadDatabase,
  type ConnectionTestDatabase,
  type ConnectionResolutionDatabase,
  ConnectionNotFoundError,
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionUnavailableError,
  ConnectionSharingRevisionConflictError,
  ConnectionSecretVersionConflictError,
  ConnectionTestInProgressError,
} from './contract.js';
export {
  uuidSchema,
  providerKeySchema,
  connectionNameSchema,
  identifierSchema,
  sealedSecretSchema,
  connectionCommand,
  keyDigest,
  safeOptionalIdentifier,
  parseRequestMetadata,
  databaseConstraint,
  decodeDurableConnectionReplay,
  serializeConnectionSnapshot,
  connectionTestOutcomeSchema,
  parseConnectionTestResult,
  serializeConnectionTestResult,
} from './admission.js';
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

export async function withConnectionTransaction<T>(
  pool: Pool,
  workspaceIdInput: string,
  {
    actorId,
    operation,
    options = {},
  }: Readonly<{
    actorId: string | undefined;
    operation: (client: PoolClient, workspaceId: string) => Promise<T>;
    options?: WorkspaceTransactionOptions | undefined;
  }>,
): Promise<T> {
  const workspaceId = uuidSchema.parse(workspaceIdInput);
  return withTenantScopedClient(
    pool,
    actorId === undefined
      ? { workspaceId }
      : { workspaceId, actorId: identifierSchema.parse(actorId) },
    async (client) => {
      await drizzle(client)
        .execute(sql`select app.lock_workspace_run_admission(${workspaceId})`)
        .catch(rethrowQueryFailure);
      return operation(client, workspaceId);
    },
    options,
  );
}

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
        eq(connections.id, uuidSchema.parse(connectionId)),
      ),
    )
    .$dynamic();
  const [row] = await (lock ? query.for('update') : query).catch(
    rethrowQueryFailure,
  );
  return row === undefined ? null : Object.freeze(row);
}
