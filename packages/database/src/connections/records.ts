import { mapConnectionHealthMetadata } from './health/metadata.js';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { withTenantScopedClient } from '../tenant-access/transactions.js';
import type { WorkspaceTransactionOptions } from '../tenant-access/transactions.js';
import {
  CONNECTION_STATUS,
  CONNECTION_AUTH_TYPE,
  type ConnectionRecord,
} from './contract.js';
import {
  uuidSchema,
  providerKeySchema,
  connectionNameSchema,
  identifierSchema,
  errorCodeSchema,
  sealedSecretSchema,
} from './admission.js';

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
export function mapConnection(
  row: Readonly<Record<string, unknown>>,
): ConnectionRecord {
  return Object.freeze({
    id: uuidSchema.parse(row.id),
    workspaceId: uuidSchema.parse(row.workspace_id),
    providerKey: providerKeySchema.parse(row.provider_key),
    name: connectionNameSchema.parse(row.name),
    authType: z.enum(CONNECTION_AUTH_TYPE).parse(row.auth_type),
    status: z.enum(CONNECTION_STATUS).parse(row.status),
    currentSecretVersionId: uuidSchema.parse(row.current_secret_version_id),
    lastTestedAt:
      row.last_tested_at === null ? null : z.date().parse(row.last_tested_at),
    lastHealthyAt:
      row.last_healthy_at === null ? null : z.date().parse(row.last_healthy_at),
    lastErrorCode:
      row.last_error_code === null
        ? null
        : errorCodeSchema.parse(row.last_error_code),
    ...mapConnectionHealthMetadata(row),
    createdBy: uuidSchema.parse(row.created_by),
    createdAt: z.date().parse(row.created_at),
    updatedAt: z.date().parse(row.updated_at),
    accessMode: z.enum(['workspace', 'restricted']).parse(row.access_mode),
  });
}

export function mapSealed(row: Readonly<Record<string, unknown>>) {
  return sealedSecretSchema.parse({
    kmsKeyReference: row.kms_key_reference,
    encryptedDataKey: row.encrypted_data_key,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    tag: row.auth_tag,
  });
}

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
      await client.query('select app.lock_workspace_run_admission($1)', [
        workspaceId,
      ]);
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
  const result = await client.query<Record<string, unknown>>(
    `select * from app.connections
     where workspace_id = $1 and id = $2${lock ? ' for update' : ''}`,
    [workspaceId, uuidSchema.parse(connectionId)],
  );
  return result.rows[0] === undefined ? null : mapConnection(result.rows[0]);
}
