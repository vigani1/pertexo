import { generatePersistedId } from '../platform/persisted-id.js';

import type { Pool } from 'pg';
import { z } from 'zod';
import {
  uuidSchema,
  providerKeySchema,
  identifierSchema,
  ConnectionUnavailableError,
  safeOptionalIdentifier,
  mapConnection,
  mapSealed,
  withConnectionTransaction,
} from './connection-persistence.js';
import type {
  ConnectionDatabase,
  ResolvedConnectionSecretRecord,
} from './connection-persistence.js';

/** Owns worker credential resolution and its access audit fact. */

export type ConnectionResolutionPersistence = Pick<
  ConnectionDatabase,
  'resolveConnectionSecret'
>;

export function createConnectionResolutionPersistence(
  pool: Pool,
): ConnectionResolutionPersistence {
  return Object.freeze({
    resolveConnectionSecret: async (
      input,
    ): Promise<ResolvedConnectionSecretRecord> => {
      const connectionId = uuidSchema.parse(input.connectionId);
      const expectedProviderKey = providerKeySchema.parse(
        input.expectedProviderKey,
      );
      const workerId = identifierSchema.parse(input.workerId);
      const purpose = z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z][a-z0-9._:-]{0,127}$/u)
        .parse(input.purpose);
      const traceId = safeOptionalIdentifier(input.traceId);
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        undefined,
        async (client, workspaceId) => {
          const result = await client.query<Record<string, unknown>>(
            `select connection.*,
                    secret.id as secret_id,
                    secret.schema_version,
                    secret.kms_key_reference,
                    secret.encrypted_data_key,
                    secret.ciphertext,
                    secret.nonce,
                    secret.auth_tag
             from app.connections connection
             join app.connection_secret_versions secret
               on secret.workspace_id = connection.workspace_id
              and secret.connection_id = connection.id
              and secret.id = connection.current_secret_version_id
             join app.workspaces workspace on workspace.id = connection.workspace_id
             where connection.workspace_id = $1 and connection.id = $2
               and connection.provider_key = $3
               and connection.status = 'active'
               and workspace.status = 'active'
             for share of connection`,
            [workspaceId, connectionId, expectedProviderKey],
          );
          const row = result.rows[0];
          if (row === undefined)
            throw new ConnectionUnavailableError(
              'Connection is not available for credential use',
            );
          const connection = mapConnection(row);
          const secretVersionId = uuidSchema.parse(row.secret_id);
          if (secretVersionId !== connection.currentSecretVersionId)
            throw new Error('Connection secret pointer is corrupt');
          await client.query(
            `insert into app.connection_events
               (id, workspace_id, connection_id, event_type, actor_kind,
                actor_id, trace_id, metadata)
             values ($1, $2, $3, 'connection.credential_accessed', 'worker',
                     $4, $5, $6::jsonb)`,
            [
              generatePersistedId(),
              workspaceId,
              connectionId,
              workerId,
              traceId,
              JSON.stringify({ purpose, secretVersionId }),
            ],
          );
          return Object.freeze({
            connection,
            secretVersionId,
            sealed: mapSealed(row),
          });
        },
      );
    },
  });
}
