import { generatePersistedId } from '../platform/persisted-id.js';

import type { Pool } from 'pg';
import { z } from 'zod';
import {
  CONNECTION_EVENT_TYPE,
  CONNECTION_STATUS,
  ConnectionNotFoundError,
  ConnectionUnavailableError,
  mapSealed,
  parseRequestMetadata,
  providerKeySchema,
  selectConnection,
  uuidSchema,
  withConnectionTransaction,
  type RequestMetadata,
  type ResolvedConnectionSecretRecord,
} from './connection-persistence.js';
import { requireConnectionUser } from './connection-authority.js';

/**
 * Owns API credential resolution for ADR 046 read-only provider lookups and
 * its access audit fact. A lookup never changes connection health.
 */

export type ResolveConnectionLookupSecretInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    expectedProviderKey: string;
    purpose: string;
    signal?: AbortSignal;
  }>;

export type ConnectionLookupDatabase = Readonly<{
  resolveConnectionLookupSecret(
    input: ResolveConnectionLookupSecretInput,
  ): Promise<ResolvedConnectionSecretRecord>;
}>;

const lookupPurposeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u)
  .max(64);

export function createConnectionLookupPersistence(
  pool: Pool,
): ConnectionLookupDatabase {
  return Object.freeze({
    resolveConnectionLookupSecret: async (input) => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const expectedProviderKey = providerKeySchema.parse(
        input.expectedProviderKey,
      );
      const purpose = lookupPurposeSchema.parse(input.purpose);
      const metadata = parseRequestMetadata(input);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionUser(client, workspaceId, actorId);
          const connection = await selectConnection(
            client,
            workspaceId,
            connectionId,
          );
          if (connection === null)
            throw new ConnectionNotFoundError('Connection is not visible');
          if (
            connection.providerKey !== expectedProviderKey ||
            connection.status !== CONNECTION_STATUS.active
          )
            throw new ConnectionUnavailableError(
              'Connection is not available for lookups',
            );
          const secret = await client.query<Record<string, unknown>>(
            `select schema_version, kms_key_reference, encrypted_data_key,
                    ciphertext, nonce, auth_tag
               from app.connection_secret_versions
              where workspace_id = $1 and connection_id = $2 and id = $3`,
            [workspaceId, connectionId, connection.currentSecretVersionId],
          );
          const row = secret.rows[0];
          if (row === undefined)
            throw new Error('Connection secret pointer is corrupt');
          await client.query(
            `insert into app.connection_events
               (id, workspace_id, connection_id, event_type, actor_kind,
                actor_id, request_id, trace_id, metadata)
             values ($1, $2, $3, $4, 'user', $5, $6, $7, $8::jsonb)`,
            [
              generatePersistedId(),
              workspaceId,
              connectionId,
              CONNECTION_EVENT_TYPE.credentialAccessed,
              actorId,
              metadata.requestId,
              metadata.traceId,
              JSON.stringify({
                purpose,
                secretVersionId: connection.currentSecretVersionId,
              }),
            ],
          );
          return Object.freeze({
            connection,
            secretVersionId: connection.currentSecretVersionId,
            sealed: mapSealed(row),
          });
        },
        input.signal === undefined ? {} : { signal: input.signal },
      );
    },
  });
}
