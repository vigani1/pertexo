import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { idempotencyRecords as records } from '../../schema/runs/support.js';
import { keyDigest } from '../admission.js';
import { withConnectionTransaction } from '../transactions.repository.js';
import { connectionTestScope } from './claim.js';

import type { ConnectionTestPersistence } from './contract.js';

export async function abandonPersistedConnectionTest(
  pool: Pool,
  input: Parameters<ConnectionTestPersistence['abandonConnectionTest']>[0],
): ReturnType<ConnectionTestPersistence['abandonConnectionTest']> {
  const actorId = input.actorId;
  const connectionId = input.connectionId;
  const requestHash = input.requestHash;
  const dispatchToken = input.dispatchToken;
  const digest = keyDigest(input.idempotencyKey);
  const scope = connectionTestScope(actorId, connectionId);
  await withConnectionTransaction(pool, input.workspaceId, {
    actorId,
    operation: async (client, workspaceId) => {
      const db = drizzle(client);
      const identity = and(
        eq(records.workspaceId, workspaceId),
        eq(records.operation, 'connection.test'),
        eq(records.scope, scope),
        eq(records.keyHash, digest),
      );
      await db
        .update(records)
        .set({
          status: 'failed',
          resultRef: { state: 'failed' },
          updatedAt: sql`transaction_timestamp()`,
        })
        .where(
          and(
            and(
              identity,
              eq(records.requestHash, requestHash),
              eq(records.status, 'in_progress'),
              sql`${records.resultRef}->>'dispatchToken'=${dispatchToken}`,
            ),
            sql`${records.resultRef}->>'state'='claimed'`,
          ),
        )
        .catch(rethrowQueryFailure);
    },
  }).catch(rethrowQueryFailure);
}
