import { generatePersistedId } from '../../platform/persisted-id.js';
import type { Pool } from 'pg';
import {
  uuidSchema,
  providerKeySchema,
  ConnectionUnavailableError,
  ConnectionTestInProgressError,
  keyDigest,
  mapConnection,
  mapSealed,
  withConnectionTransaction,
  parseRequestMetadata,
} from '../records.queries.js';
import { connectionTestClaim, connectionTestScope } from './claim.js';
import { requireConnectionUser } from '../authority.queries.js';

import { sha256HexSchema as digestSchema } from '../../platform/persisted-primitives.js';

import type { ConnectionTestPersistence } from './results.repository.js';

export async function resolvePersistedConnectionTestSecret(
  pool: Pool,
  input: Parameters<
    ConnectionTestPersistence['resolveConnectionTestSecret']
  >[0],
): ReturnType<ConnectionTestPersistence['resolveConnectionTestSecret']> {
  const actorId = uuidSchema.parse(input.actorId);
  const connectionId = uuidSchema.parse(input.connectionId);
  const expectedProviderKey = providerKeySchema.parse(
    input.expectedProviderKey,
  );
  const requestHash = digestSchema.parse(input.requestHash);
  const dispatchToken = uuidSchema.parse(input.dispatchToken);
  const digest = keyDigest(input.idempotencyKey);
  const scope = connectionTestScope(actorId, connectionId);
  const metadata = parseRequestMetadata(input);
  return withConnectionTransaction(pool, input.workspaceId, {
    actorId,
    operation: async (client, workspaceId) => {
      await requireConnectionUser(client, workspaceId, actorId, connectionId);
      const claim = await client.query(
        `select 1 from app.idempotency_records
             where workspace_id = $1 and operation = 'connection.test'
               and scope = $2 and key_hash = $3 and request_hash = $4
               and status = 'in_progress'
               and result_ref->>'dispatchToken' = $5
               and result_ref->>'state' = 'claimed' for update`,
        [workspaceId, scope, digest, requestHash, dispatchToken],
      );
      if (claim.rowCount !== 1)
        throw new ConnectionTestInProgressError(
          'Connection test credential ownership was lost',
        );
      const resolved = await client.query<
        Record<string, unknown> & { test_health_revision: string }
      >(
        `select connection.*,
                    connection.health_revision::text as test_health_revision,
                    secret.id as secret_id,
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
             where connection.workspace_id = $1 and connection.id = $2
               and connection.provider_key = $3
               and connection.status <> 'revoked'
             for share of connection`,
        [workspaceId, connectionId, expectedProviderKey],
      );
      const row = resolved.rows[0];
      if (row === undefined)
        throw new ConnectionUnavailableError(
          'Connection is not available for testing',
        );
      const connection = mapConnection(row);
      const secretVersionId = uuidSchema.parse(row.secret_id);
      if (secretVersionId !== connection.currentSecretVersionId)
        throw new Error('Connection secret pointer is corrupt');
      // DNS and safety checks may fail before dispatch. Capture their
      // current-credential fence now, without inventing dispatch evidence.
      await client.query(
        `update app.idempotency_records
             set result_ref = $1::jsonb, updated_at = transaction_timestamp()
             where workspace_id = $2 and operation = 'connection.test'
               and scope = $3 and key_hash = $4`,
        [
          JSON.stringify(
            connectionTestClaim(
              dispatchToken,
              'claimed',
              secretVersionId,
              row.test_health_revision,
            ),
          ),
          workspaceId,
          scope,
          digest,
        ],
      );
      await client.query(
        `insert into app.connection_events
               (id, workspace_id, connection_id, event_type, actor_kind,
                actor_id, request_id, trace_id, metadata)
             values ($1, $2, $3, 'connection.credential_accessed', 'user',
                     $4, $5, $6, $7::jsonb)`,
        [
          generatePersistedId(),
          workspaceId,
          connectionId,
          actorId,
          metadata.requestId,
          metadata.traceId,
          JSON.stringify({
            purpose: 'connection.test',
            secretVersionId,
          }),
        ],
      );
      return Object.freeze({
        connection,
        secretVersionId,
        sealed: mapSealed(row),
      });
    },
  });
}
