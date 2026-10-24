import type { Pool } from 'pg';
import {
  uuidSchema,
  keyDigest,
  withConnectionTransaction,
} from '../records.queries.js';
import { connectionTestScope } from './claim.js';

import { sha256HexSchema as digestSchema } from '../../platform/persisted-primitives.js';

import type { ConnectionTestPersistence } from './results.repository.js';

export async function abandonPersistedConnectionTest(
  pool: Pool,
  input: Parameters<ConnectionTestPersistence['abandonConnectionTest']>[0],
): ReturnType<ConnectionTestPersistence['abandonConnectionTest']> {
  const actorId = uuidSchema.parse(input.actorId);
  const connectionId = uuidSchema.parse(input.connectionId);
  const requestHash = digestSchema.parse(input.requestHash);
  const dispatchToken = uuidSchema.parse(input.dispatchToken);
  const digest = keyDigest(input.idempotencyKey);
  const scope = connectionTestScope(actorId, connectionId);
  await withConnectionTransaction(pool, input.workspaceId, {
    actorId,
    operation: async (client, workspaceId) => {
      await client.query(
        `update app.idempotency_records
             set status = 'failed',
                 result_ref = '{"state":"failed"}'::jsonb,
                 updated_at = transaction_timestamp()
             where workspace_id = $1 and operation = 'connection.test'
                and scope = $2 and key_hash = $3 and request_hash = $4
                and status = 'in_progress'
                and result_ref->>'dispatchToken' = $5
                and result_ref->>'state' = 'claimed'`,
        [workspaceId, scope, digest, requestHash, dispatchToken],
      );
    },
  });
}
