import { generatePersistedId } from '../../platform/persisted-id.js';
import type { Pool } from 'pg';
import {
  uuidSchema,
  providerKeySchema,
  CONNECTION_STATUS,
  ConnectionIdempotencyConflictError,
  ConnectionUnavailableError,
  ConnectionTestInProgressError,
  keyDigest,
  withConnectionTransaction,
  selectConnection,
  parseConnectionTestResult,
} from '../records.queries.js';
import {
  connectionTestClaim,
  connectionTestClaimSchema,
  connectionTestScope,
} from './claim.js';
import { requireConnectionUser } from '../authority.queries.js';

import { sha256HexSchema as digestSchema } from '../../platform/persisted-primitives.js';

import type { ConnectionTestPersistence } from './results.repository.js';

export async function startPersistedConnectionTest(
  pool: Pool,
  input: Parameters<ConnectionTestPersistence['startConnectionTest']>[0],
): ReturnType<ConnectionTestPersistence['startConnectionTest']> {
  const actorId = uuidSchema.parse(input.actorId);
  const connectionId = uuidSchema.parse(input.connectionId);
  const expectedProviderKey = providerKeySchema.parse(
    input.expectedProviderKey,
  );
  const requestHash = digestSchema.parse(input.requestHash);
  const digest = keyDigest(input.idempotencyKey);
  const dispatchToken = uuidSchema.parse(input.dispatchToken);
  const scope = connectionTestScope(actorId, connectionId);
  return withConnectionTransaction(pool, input.workspaceId, {
    actorId,
    operation: async (client, workspaceId) => {
      await requireConnectionUser(client, workspaceId, actorId, connectionId);
      const inserted = await client.query(
        `insert into app.idempotency_records
               (id, workspace_id, operation, scope, key_hash, request_hash,
                status, resource_id, result_ref)
             values ($1, $2, 'connection.test', $3, $4, $5, 'in_progress',
                     $6, $7::jsonb)
             on conflict (workspace_id, operation, scope, key_hash) do nothing
             returning id`,
        [
          generatePersistedId(),
          workspaceId,
          scope,
          digest,
          requestHash,
          connectionId,
          JSON.stringify(connectionTestClaim(dispatchToken, 'claimed')),
        ],
      );
      const claim = await client.query<{
        request_hash: string;
        result_ref: unknown;
        stale: boolean;
        status: string;
      }>(
        `select request_hash, status, result_ref,
                    updated_at < transaction_timestamp() - interval '2 minutes'
                      as stale
             from app.idempotency_records
             where workspace_id = $1 and operation = 'connection.test'
               and scope = $2 and key_hash = $3 for update`,
        [workspaceId, scope, digest],
      );
      const current = claim.rows[0];
      if (current === undefined)
        throw new Error('Connection test idempotency claim is unavailable');
      if (current.request_hash !== requestHash)
        throw new ConnectionIdempotencyConflictError(
          'Idempotency key request mismatch',
        );
      if (current.status === 'completed') {
        const result = parseConnectionTestResult(current.result_ref);
        if (
          result.connection.workspaceId !== workspaceId ||
          result.connection.id !== connectionId
        )
          throw new Error('Connection test idempotency result is corrupt');
        return Object.freeze({ kind: 'replay' as const, result });
      }
      const ownsClaim = inserted.rowCount === 1;
      if (!ownsClaim) {
        if (
          current.status === 'in_progress' &&
          connectionTestClaimSchema.parse(current.result_ref).state ===
            'dispatched'
        )
          throw new ConnectionTestInProgressError(
            'Connection test has durable dispatch evidence',
          );
        if (current.status !== 'failed' && !current.stale)
          throw new ConnectionTestInProgressError(
            'Connection test is already in progress',
          );
        await client.query(
          `update app.idempotency_records
               set status = 'in_progress', result_ref = $1::jsonb,
                   updated_at = transaction_timestamp()
               where workspace_id = $2 and operation = 'connection.test'
                 and scope = $3 and key_hash = $4`,
          [
            JSON.stringify(connectionTestClaim(dispatchToken, 'claimed')),
            workspaceId,
            scope,
            digest,
          ],
        );
      }

      const connection = await selectConnection(
        client,
        workspaceId,
        connectionId,
      );
      if (
        connection?.providerKey !== expectedProviderKey ||
        connection.status === CONNECTION_STATUS.revoked
      )
        throw new ConnectionUnavailableError(
          'Connection is not available for testing',
        );
      return Object.freeze({
        kind: 'dispatch' as const,
        dispatchToken,
      });
    },
  });
}
