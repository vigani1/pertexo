import { generatePersistedId } from '../platform/persisted-id.js';

import type { Pool } from 'pg';
import { z } from 'zod';
import {
  uuidSchema,
  digestSchema,
  providerKeySchema,
  sealedSecretSchema,
  CONNECTION_STATUS,
  CONNECTION_AUTH_TYPE,
  ConnectionNotFoundError,
  ConnectionIdempotencyConflictError,
  ConnectionUnavailableError,
  ConnectionSecretVersionConflictError,
  keyDigest,
  mapConnection,
  withConnectionTransaction,
  requireConnectionManager,
  parseRequestMetadata,
  selectConnection,
  durableCreateResult,
  durableConnectionSnapshot,
  serializeConnectionSnapshot,
} from './connection-persistence.js';
import type {
  ConnectionDatabase,
  ConnectionRecord,
} from './connection-persistence.js';

/** Owns secret rotation idempotency and current-version fencing. */

export type ConnectionSecretPersistence = Pick<
  ConnectionDatabase,
  | 'findConnectionRotateReplay'
  | 'rotateConnectionSecret'
  | 'assertConnectionSecretCurrent'
>;

export function createConnectionSecretPersistence(
  pool: Pool,
): ConnectionSecretPersistence {
  return Object.freeze({
    findConnectionRotateReplay: async (
      input,
    ): Promise<ConnectionRecord | null> => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const requestHash = digestSchema.parse(input.requestHash);
      const digest = keyDigest(input.idempotencyKey);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionManager(client, workspaceId, actorId);
          const scope = `${actorId}:${connectionId}`;
          const result = await client.query<{
            request_hash: string;
            status: string;
            result_ref: unknown;
          }>(
            `select request_hash, status, result_ref
             from app.idempotency_records
             where workspace_id = $1
               and operation = 'connection.secret.rotate'
               and scope = $2 and key_hash = $3`,
            [workspaceId, scope, digest],
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
            if (
              snapshot.id !== connectionId ||
              snapshot.workspaceId !== workspaceId
            )
              throw new Error(
                'Connection rotation idempotency result is corrupt',
              );
            return snapshot;
          }
          const replay = durableCreateResult(record.result_ref);
          const connection = await selectConnection(
            client,
            workspaceId,
            replay.connectionId,
          );
          if (replay.connectionId !== connectionId || connection === null)
            throw new Error(
              'Connection rotation idempotency result is corrupt',
            );
          return connection;
        },
      );
    },

    rotateConnectionSecret: async (input): Promise<ConnectionRecord> => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const secretVersionId = uuidSchema.parse(input.secretVersionId);
      const expected = uuidSchema.parse(input.expectedCurrentSecretVersionId);
      const sealed = sealedSecretSchema.parse(input.sealed);
      const requestHash = digestSchema.parse(input.requestHash);
      const digest = keyDigest(input.idempotencyKey);
      const metadata = parseRequestMetadata(input);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionManager(client, workspaceId, actorId);
          const scope = `${actorId}:${connectionId}`;
          await client.query(
            `insert into app.idempotency_records
               (id, workspace_id, operation, scope, key_hash, request_hash,
                status, resource_id, result_ref)
             values ($1, $2, 'connection.secret.rotate', $3, $4, $5,
                     'in_progress', $6, '{}'::jsonb)
             on conflict (workspace_id, operation, scope, key_hash) do nothing`,
            [
              generatePersistedId(),
              workspaceId,
              scope,
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
             where workspace_id = $1
               and operation = 'connection.secret.rotate'
               and scope = $2 and key_hash = $3 for update`,
            [workspaceId, scope, digest],
          );
          const claimed = claim.rows[0];
          if (claimed === undefined)
            throw new Error(
              'Connection rotation idempotency claim is unavailable',
            );
          if (claimed.request_hash !== requestHash)
            throw new ConnectionIdempotencyConflictError(
              'Idempotency key request mismatch',
            );
          if (claimed.status === 'completed') {
            const snapshot = durableConnectionSnapshot(claimed.result_ref);
            if (snapshot !== null) {
              if (
                snapshot.id !== connectionId ||
                snapshot.workspaceId !== workspaceId
              )
                throw new Error(
                  'Connection rotation idempotency result is corrupt',
                );
              return snapshot;
            }
            const replay = durableCreateResult(claimed.result_ref);
            const existing = await selectConnection(
              client,
              workspaceId,
              replay.connectionId,
            );
            if (existing === null || replay.connectionId !== connectionId)
              throw new Error(
                'Connection rotation idempotency result is corrupt',
              );
            return existing;
          }
          const connection = await selectConnection(
            client,
            workspaceId,
            connectionId,
            true,
          );
          if (connection === null)
            throw new ConnectionNotFoundError('Connection is not visible');
          if (connection.status === CONNECTION_STATUS.revoked)
            throw new ConnectionUnavailableError('Connection is revoked');
          if (
            connection.authType !==
            (input.expectedAuthType ?? CONNECTION_AUTH_TYPE.httpHeaders)
          )
            throw new ConnectionUnavailableError(
              'Connection authentication type cannot be changed by rotation',
            );
          if (connection.currentSecretVersionId !== expected)
            throw new ConnectionSecretVersionConflictError(
              'Connection secret version does not match',
            );
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
          const updated = await client.query<Record<string, unknown>>(
            `update app.connections
             set current_secret_version_id = $1, status = 'active',
                 last_error_code = null, updated_at = transaction_timestamp()
             where workspace_id = $2 and id = $3
             returning *`,
            [secretVersionId, workspaceId, connectionId],
          );
          await client.query(
            `insert into app.connection_events
               (id, workspace_id, connection_id, event_type, actor_kind,
                actor_id, request_id, trace_id, metadata)
             values ($1, $2, $3, 'connection.secret_rotated', 'user', $4,
                     $5, $6, $7::jsonb)`,
            [
              generatePersistedId(),
              workspaceId,
              connectionId,
              actorId,
              metadata.requestId,
              metadata.traceId,
              JSON.stringify({
                previousSecretVersionId: expected,
                secretVersionId,
              }),
            ],
          );
          const row = updated.rows[0];
          if (row === undefined)
            throw new Error('Connection rotation returned no row');
          const rotated = mapConnection(row);
          await client.query(
            `update app.idempotency_records
             set status = 'completed', result_ref = $1::jsonb,
                 updated_at = transaction_timestamp()
             where workspace_id = $2
               and operation = 'connection.secret.rotate'
               and scope = $3 and key_hash = $4`,
            [
              JSON.stringify(serializeConnectionSnapshot(rotated)),
              workspaceId,
              scope,
              digest,
            ],
          );
          return rotated;
        },
      );
    },

    assertConnectionSecretCurrent: async (input): Promise<void> => {
      const connectionId = uuidSchema.parse(input.connectionId);
      const expectedProviderKey = providerKeySchema.parse(
        input.expectedProviderKey,
      );
      const expectedAuthType = z
        .enum(CONNECTION_AUTH_TYPE)
        .parse(input.expectedAuthType);
      const secretVersionId = uuidSchema.parse(input.secretVersionId);
      await withConnectionTransaction(
        pool,
        input.workspaceId,
        undefined,
        async (client, workspaceId) => {
          const result = await client.query(
            `select 1
             from app.connections connection
             join app.workspaces workspace on workspace.id = connection.workspace_id
             where connection.workspace_id = $1 and connection.id = $2
               and connection.provider_key = $3 and connection.auth_type = $4
               and connection.current_secret_version_id = $5
               and connection.status = 'active' and workspace.status = 'active'`,
            [
              workspaceId,
              connectionId,
              expectedProviderKey,
              expectedAuthType,
              secretVersionId,
            ],
          );
          if (result.rowCount !== 1)
            throw new ConnectionUnavailableError(
              'Connection is not current for credential use',
            );
        },
      );
    },
  });
}
