import type { Pool } from 'pg';

import { generatePersistedId } from '../platform/persisted-id.js';
import { sha256HexSchema as digestSchema } from '../validation/persisted-primitives.js';
import { requireConnectionUser } from './connection-authority.js';
import {
  connectionTestClaim,
  connectionTestClaimSchema,
  connectionTestScope,
} from './connection-test-claim.js';
import {
  CONNECTION_STATUS,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
  keyDigest,
  parseRequestMetadata,
  selectConnection,
  uuidSchema,
  withConnectionTransaction,
} from './connection-persistence.js';
import type { MarkConnectionTestDispatchedInput } from './connection-persistence.js';

export async function markConnectionTestDispatched(
  pool: Pool,
  input: MarkConnectionTestDispatchedInput,
): Promise<void> {
  const actorId = uuidSchema.parse(input.actorId);
  const connectionId = uuidSchema.parse(input.connectionId);
  const secretVersionId = uuidSchema.parse(input.secretVersionId);
  const requestHash = digestSchema.parse(input.requestHash);
  const dispatchToken = uuidSchema.parse(input.dispatchToken);
  const digest = keyDigest(input.idempotencyKey);
  const scope = connectionTestScope(actorId, connectionId);
  const metadata = parseRequestMetadata(input);
  await withConnectionTransaction(
    pool,
    input.workspaceId,
    actorId,
    async (client, workspaceId) => {
      await requireConnectionUser(client, workspaceId, actorId);
      const claim = await client.query<{ result_ref: unknown }>(
        `select result_ref from app.idempotency_records
         where workspace_id = $1 and operation = 'connection.test'
           and scope = $2 and key_hash = $3 and request_hash = $4
           and status = 'in_progress'
           and result_ref->>'dispatchToken' = $5 for update`,
        [workspaceId, scope, digest, requestHash, dispatchToken],
      );
      const claimRow = claim.rows[0];
      if (claimRow === undefined)
        throw new ConnectionTestInProgressError(
          'Connection test dispatch ownership was lost',
        );
      if (
        connectionTestClaimSchema.parse(claimRow.result_ref).state !== 'claimed'
      )
        throw new ConnectionTestInProgressError(
          'Connection test already has durable dispatch evidence',
        );
      const connection = await selectConnection(
        client,
        workspaceId,
        connectionId,
        true,
      );
      if (
        connection?.status !== CONNECTION_STATUS.active ||
        connection.currentSecretVersionId !== secretVersionId
      )
        throw new ConnectionUnavailableError(
          'Connection changed before test dispatch',
        );
      const marked = await client.query(
        `update app.idempotency_records
         set result_ref = $1::jsonb, updated_at = transaction_timestamp()
         where workspace_id = $2 and operation = 'connection.test'
           and scope = $3 and key_hash = $4 and request_hash = $5
           and status = 'in_progress'
           and result_ref->>'dispatchToken' = $6
           and result_ref->>'state' = 'claimed'`,
        [
          JSON.stringify(
            connectionTestClaim(dispatchToken, 'dispatched', secretVersionId),
          ),
          workspaceId,
          scope,
          digest,
          requestHash,
          dispatchToken,
        ],
      );
      if (marked.rowCount !== 1)
        throw new ConnectionTestInProgressError(
          'Connection test dispatch ownership was lost',
        );
      await client.query(
        `insert into app.audit_events
           (id, workspace_id, actor_user_id, action, target_type,
            target_id, request_id, trace_id, metadata)
         values ($1, $2, $3, 'connection.test_dispatched', 'connection',
                 $4, $5, $6, $7::jsonb)`,
        [
          generatePersistedId(),
          workspaceId,
          actorId,
          connectionId,
          metadata.requestId,
          metadata.traceId,
          JSON.stringify({ secretVersionId }),
        ],
      );
    },
  );
}
