import { generatePersistedId } from '../platform/persisted-id.js';

import type { Pool } from 'pg';
import { z } from 'zod';
import {
  uuidSchema,
  providerKeySchema,
  connectionNameSchema,
  sealedSecretSchema,
  CONNECTION_STATUS,
  CONNECTION_AUTH_TYPE,
  ConnectionNotFoundError,
  ConnectionConflictError,
  connectionCommand,
  mapConnection,
  withConnectionTransaction,
  parseRequestMetadata,
  selectConnection,
  databaseConstraint,
  decodeDurableConnectionReplay,
  serializeConnectionSnapshot,
} from './records.js';
import { requireConnectionManager } from './authority.js';
import { revokeConnectionHealth } from './health/transitions.js';
import {
  claimCommand,
  completeCommand,
  findCommandResult,
} from '../platform/idempotency.js';
import type { ConnectionDatabase, ConnectionRecord } from './records.js';

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
      const metadata = parseRequestMetadata(input);
      try {
        return await withConnectionTransaction(
          pool,
          input.workspaceId,
          actorId,
          async (client, workspaceId) => {
            await requireConnectionManager(client, workspaceId, actorId);
            const command = connectionCommand(
              input,
              workspaceId,
              'connection.create',
              actorId,
            );
            const stored = await claimCommand(client, {
              ...command,
              resourceId: connectionId,
            });
            if (stored !== null) {
              const replay = decodeDurableConnectionReplay(stored);
              if (replay.workspaceId !== workspaceId)
                throw new Error('Connection idempotency result is corrupt');
              return replay;
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
                 (id, workspace_id, connection_id,
                  kms_key_reference, encrypted_data_key, ciphertext, nonce,
                  auth_tag, created_by)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                secretVersionId,
                workspaceId,
                connectionId,
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
            await completeCommand(
              client,
              command,
              serializeConnectionSnapshot(connection),
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
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionManager(client, workspaceId, actorId);
          const stored = await findCommandResult(
            client,
            connectionCommand(input, workspaceId, 'connection.create', actorId),
          );
          if (stored === null) return null;
          const replay = decodeDurableConnectionReplay(stored);
          if (replay.workspaceId !== workspaceId)
            throw new Error('Connection idempotency result is corrupt');
          return replay;
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
          const updated = await revokeConnectionHealth(
            client,
            workspaceId,
            connectionId,
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
