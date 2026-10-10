import { generatePersistedId } from '../platform/persisted-id.js';

import type { Pool } from 'pg';
import { z } from 'zod';
import {
  uuidSchema,
  providerKeySchema,
  sealedSecretSchema,
  CONNECTION_STATUS,
  CONNECTION_AUTH_TYPE,
  ConnectionNotFoundError,
  ConnectionUnavailableError,
  ConnectionSecretVersionConflictError,
  connectionCommand,
  mapConnection,
  withConnectionTransaction,
  parseRequestMetadata,
  selectConnection,
  decodeDurableConnectionReplay,
  serializeConnectionSnapshot,
} from './records.js';
import { requireConnectionManager } from './authority.js';
import { rotateConnectionHealth } from './health/transitions.js';
import {
  claimCommand,
  completeCommand,
  findCommandResult,
} from '../platform/idempotency.js';
import type { ConnectionDatabase, ConnectionRecord } from './records.js';

/** Owns secret rotation idempotency and current-version fencing. */

export type ConnectionSecretPersistence = Pick<
  ConnectionDatabase,
  | 'findConnectionRotateReplay'
  | 'rotateConnectionSecret'
  | 'assertConnectionSecretCurrent'
>;

function parseConnectionAuthType(input: unknown) {
  return z.enum(CONNECTION_AUTH_TYPE).parse(input);
}

export function createConnectionSecretPersistence(
  pool: Pool,
): ConnectionSecretPersistence {
  return Object.freeze({
    findConnectionRotateReplay: async (
      input,
    ): Promise<ConnectionRecord | null> => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionManager(client, workspaceId, actorId);
          const stored = await findCommandResult(
            client,
            connectionCommand(
              input,
              workspaceId,
              'connection.secret.rotate',
              `${actorId}:${connectionId}`,
            ),
          );
          if (stored === null) return null;
          const replay = decodeDurableConnectionReplay(stored);
          if (replay.id !== connectionId || replay.workspaceId !== workspaceId)
            throw new Error(
              'Connection rotation idempotency result is corrupt',
            );
          return replay;
        },
      );
    },
    rotateConnectionSecret: async (input): Promise<ConnectionRecord> => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const secretVersionId = uuidSchema.parse(input.secretVersionId);
      const expected = uuidSchema.parse(input.expectedCurrentSecretVersionId);
      const sealed = sealedSecretSchema.parse(input.sealed);
      const metadata = parseRequestMetadata(input);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionManager(client, workspaceId, actorId);
          const command = connectionCommand(
            input,
            workspaceId,
            'connection.secret.rotate',
            `${actorId}:${connectionId}`,
          );
          const stored = await claimCommand(client, {
            ...command,
            resourceId: connectionId,
          });
          if (stored !== null) {
            const replay = decodeDurableConnectionReplay(stored);
            if (
              replay.id !== connectionId ||
              replay.workspaceId !== workspaceId
            )
              throw new Error(
                'Connection rotation idempotency result is corrupt',
              );
            return replay;
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
          const updated = await rotateConnectionHealth(
            client,
            workspaceId,
            connectionId,
            secretVersionId,
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
          await completeCommand(
            client,
            command,
            serializeConnectionSnapshot(rotated),
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
      const expectedAuthType = parseConnectionAuthType(input.expectedAuthType);
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
        input.signal === undefined ? {} : { signal: input.signal },
      );
    },
  });
}
