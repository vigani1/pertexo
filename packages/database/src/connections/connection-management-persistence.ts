import { generatePersistedId } from '../platform/persisted-id.js';

import type { Pool } from 'pg';
import { z } from 'zod';
import {
  uuidSchema,
  digestSchema,
  providerKeySchema,
  connectionNameSchema,
  sealedSecretSchema,
  CONNECTION_STATUS,
  CONNECTION_AUTH_TYPE,
  ConnectionNotFoundError,
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  keyDigest,
  mapConnection,
  withConnectionTransaction,
  requireConnectionManager,
  parseRequestMetadata,
  selectConnection,
  databaseConstraint,
  durableCreateResult,
  durableConnectionSnapshot,
  serializeConnectionSnapshot,
} from './connection-persistence.js';
import type {
  ConnectionDatabase,
  ConnectionRecord,
} from './connection-persistence.js';

/** Owns atomic creation/idempotency, reads, and revocation transactions. */

export type ConnectionManagementPersistence = Pick<
  ConnectionDatabase,
  | 'createConnection'
  | 'findConnectionCreateReplay'
  | 'getConnection'
  | 'revokeConnection'
>;

export function createConnectionManagementPersistence(
  pool: Pool,
): ConnectionManagementPersistence {
  return Object.freeze({
    createConnection: async (input): Promise<ConnectionRecord> => {
      const connectionId = uuidSchema.parse(input.connectionId);
      const secretVersionId = uuidSchema.parse(input.secretVersionId);
      const actorId = uuidSchema.parse(input.actorId);
      const providerKey = providerKeySchema.parse(input.providerKey);
      const name = connectionNameSchema.parse(input.name);
      const authType = z.enum(CONNECTION_AUTH_TYPE).parse(input.authType);
      const sealed = sealedSecretSchema.parse(input.sealed);
      const requestHash = digestSchema.parse(input.requestHash);
      const digest = keyDigest(input.idempotencyKey);
      const metadata = parseRequestMetadata(input);
      try {
        return await withConnectionTransaction(
          pool,
          input.workspaceId,
          actorId,
          async (client, workspaceId) => {
            await requireConnectionManager(client, workspaceId, actorId);
            await client.query(
              `insert into app.idempotency_records
                 (id, workspace_id, operation, scope, key_hash, request_hash,
                  status, resource_id, result_ref)
               values ($1, $2, 'connection.create', $3, $4, $5,
                       'in_progress', $6, '{}'::jsonb)
               on conflict (workspace_id, operation, scope, key_hash) do nothing`,
              [
                generatePersistedId(),
                workspaceId,
                actorId,
                digest,
                requestHash,
                connectionId,
              ],
            );
            const claim = await client.query<{
              request_hash: string;
              status: string;
              result_ref: unknown;
            }>(
              `select request_hash, status, result_ref
               from app.idempotency_records
               where workspace_id = $1 and operation = 'connection.create'
                 and scope = $2 and key_hash = $3 for update`,
              [workspaceId, actorId, digest],
            );
            const claimed = claim.rows[0];
            if (claimed === undefined)
              throw new Error('Connection idempotency claim is unavailable');
            if (claimed.request_hash !== requestHash)
              throw new ConnectionIdempotencyConflictError(
                'Idempotency key request mismatch',
              );
            if (claimed.status === 'completed') {
              const snapshot = durableConnectionSnapshot(claimed.result_ref);
              if (snapshot !== null) {
                if (snapshot.workspaceId !== workspaceId)
                  throw new Error('Connection idempotency result is corrupt');
                return snapshot;
              }
              const replay = durableCreateResult(claimed.result_ref);
              const existing = await selectConnection(
                client,
                workspaceId,
                replay.connectionId,
              );
              if (existing === null)
                throw new Error('Connection idempotency result is corrupt');
              return existing;
            }

            const inserted = await client.query<Record<string, unknown>>(
              `insert into app.connections
                 (id, workspace_id, provider_key, name, auth_type, status,
                  current_secret_version_id, created_by)
               values ($1, $2, $3, $4, $5, 'active', $6, $7)
               returning *`,
              [
                connectionId,
                workspaceId,
                providerKey,
                name,
                authType,
                secretVersionId,
                actorId,
              ],
            );
            const row = inserted.rows[0];
            if (row === undefined)
              throw new Error('Connection insert returned no row');
            const connection = mapConnection(row);
            await client.query(
              `insert into app.connection_secret_versions
                 (id, workspace_id, connection_id, schema_version,
                  kms_key_reference, encrypted_data_key, ciphertext, nonce,
                  auth_tag, created_by)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                secretVersionId,
                workspaceId,
                connectionId,
                sealed.schemaVersion,
                sealed.kmsKeyReference,
                sealed.encryptedDataKey,
                sealed.ciphertext,
                sealed.nonce,
                sealed.tag,
                actorId,
              ],
            );
            await client.query(
              `insert into app.connection_events
                 (id, workspace_id, connection_id, event_type, actor_kind,
                  actor_id, request_id, trace_id, metadata)
               values ($1, $2, $3, 'connection.created', 'user', $4, $5, $6,
                       $7::jsonb)`,
              [
                generatePersistedId(),
                workspaceId,
                connectionId,
                actorId,
                metadata.requestId,
                metadata.traceId,
                JSON.stringify({
                  providerKey,
                  authType,
                  secretVersionId,
                }),
              ],
            );
            await client.query(
              `insert into app.audit_events
                 (id, workspace_id, actor_user_id, action, target_type,
                  target_id, request_id, trace_id, metadata)
               values ($1, $2, $3, 'connection.created', 'connection', $4,
                       $5, $6, $7::jsonb)`,
              [
                generatePersistedId(),
                workspaceId,
                actorId,
                connectionId,
                metadata.requestId,
                metadata.traceId,
                JSON.stringify({ providerKey, authType, secretVersionId }),
              ],
            );
            await client.query(
              `update app.idempotency_records
               set status = 'completed', result_ref = $1::jsonb,
                   updated_at = transaction_timestamp()
               where workspace_id = $2 and operation = 'connection.create'
                 and scope = $3 and key_hash = $4`,
              [
                JSON.stringify(serializeConnectionSnapshot(connection)),
                workspaceId,
                actorId,
                digest,
              ],
            );
            return connection;
          },
        );
      } catch (error: unknown) {
        if (
          databaseConstraint(error, 'connections_active_name_provider_unique')
        )
          throw new ConnectionConflictError(
            'An active connection already uses this provider and name',
          );
        throw error;
      }
    },

    findConnectionCreateReplay: async (
      input,
    ): Promise<ConnectionRecord | null> => {
      const actorId = uuidSchema.parse(input.actorId);
      const requestHash = digestSchema.parse(input.requestHash);
      const digest = keyDigest(input.idempotencyKey);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionManager(client, workspaceId, actorId);
          const result = await client.query<{
            request_hash: string;
            status: string;
            result_ref: unknown;
          }>(
            `select request_hash, status, result_ref
             from app.idempotency_records
             where workspace_id = $1 and operation = 'connection.create'
               and scope = $2 and key_hash = $3`,
            [workspaceId, actorId, digest],
          );
          const record = result.rows[0];
          if (record === undefined) return null;
          if (record.request_hash !== requestHash)
            throw new ConnectionIdempotencyConflictError(
              'Idempotency key request mismatch',
            );
          if (record.status !== 'completed') return null;
          const snapshot = durableConnectionSnapshot(record.result_ref);
          if (snapshot !== null) {
            if (snapshot.workspaceId !== workspaceId)
              throw new Error('Connection idempotency result is corrupt');
            return snapshot;
          }
          const replay = durableCreateResult(record.result_ref);
          const connection = await selectConnection(
            client,
            workspaceId,
            replay.connectionId,
          );
          if (connection === null)
            throw new Error('Connection idempotency result is corrupt');
          return connection;
        },
      );
    },

    getConnection: (workspaceId, connectionId) =>
      withConnectionTransaction(
        pool,
        workspaceId,
        undefined,
        (client, parsedWorkspaceId) =>
          selectConnection(client, parsedWorkspaceId, connectionId),
      ),

    revokeConnection: async (input): Promise<ConnectionRecord> => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const metadata = parseRequestMetadata(input);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionManager(client, workspaceId, actorId);
          const connection = await selectConnection(
            client,
            workspaceId,
            connectionId,
            true,
          );
          if (connection === null)
            throw new ConnectionNotFoundError('Connection is not visible');
          if (connection.status === CONNECTION_STATUS.revoked)
            return connection;
          const updated = await client.query<Record<string, unknown>>(
            `update app.connections
             set status = 'revoked', updated_at = transaction_timestamp()
             where workspace_id = $1 and id = $2 returning *`,
            [workspaceId, connectionId],
          );
          await client.query(
            `insert into app.connection_events
               (id, workspace_id, connection_id, event_type, actor_kind,
                actor_id, request_id, trace_id, metadata)
             values ($1, $2, $3, 'connection.revoked', 'user', $4, $5, $6,
                     '{}'::jsonb)`,
            [
              generatePersistedId(),
              workspaceId,
              connectionId,
              actorId,
              metadata.requestId,
              metadata.traceId,
            ],
          );
          const row = updated.rows[0];
          if (row === undefined)
            throw new Error('Connection revocation returned no row');
          return mapConnection(row);
        },
      );
    },
  });
}
