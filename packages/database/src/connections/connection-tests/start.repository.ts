import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { idempotencyRecords as records } from '../../schema/runs/support.js';
import { keyDigest, parseConnectionTestResult } from '../admission.js';
import { requireConnectionUser } from '../authority.queries.js';
import {
  CONNECTION_STATUS,
  ConnectionIdempotencyConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
} from '../contract.js';
import { selectConnection } from '../records.queries.js';
import { withConnectionTransaction } from '../transactions.repository.js';
import {
  connectionTestClaim,
  connectionTestClaimSchema,
  connectionTestScope,
} from './claim.js';

import type { ConnectionTestPersistence } from './contract.js';

export async function startPersistedConnectionTest(
  pool: Pool,
  input: Parameters<ConnectionTestPersistence['startConnectionTest']>[0],
): ReturnType<ConnectionTestPersistence['startConnectionTest']> {
  const actorId = input.actorId;
  const connectionId = input.connectionId;
  const expectedProviderKey = input.expectedProviderKey;
  const requestHash = input.requestHash;
  const digest = keyDigest(input.idempotencyKey);
  const dispatchToken = input.dispatchToken;
  const scope = connectionTestScope(actorId, connectionId);
  return withConnectionTransaction(pool, input.workspaceId, {
    actorId,
    operation: async (client, workspaceId) => {
      const db = drizzle(client);
      const identity = and(
        eq(records.workspaceId, workspaceId),
        eq(records.operation, 'connection.test'),
        eq(records.scope, scope),
        eq(records.keyHash, digest),
      );
      await requireConnectionUser(client, workspaceId, actorId, connectionId);
      const inserted = await db
        .insert(records)
        .values({
          id: generatePersistedId(),
          workspaceId,
          operation: 'connection.test',
          scope,
          keyHash: digest,
          requestHash,
          status: 'in_progress',
          resourceId: connectionId,
          resultRef: connectionTestClaim(dispatchToken, 'claimed'),
        })
        .onConflictDoNothing({
          target: [
            records.workspaceId,
            records.operation,
            records.scope,
            records.keyHash,
          ],
        })
        .returning({ id: records.id })
        .catch(rethrowQueryFailure);
      const [current] = await db
        .select({
          requestHash: records.requestHash,
          status: records.status,
          resultRef: records.resultRef,
          stale: sql<boolean>`${records.updatedAt}<transaction_timestamp()-interval '2 minutes'`,
        })
        .from(records)
        .where(identity)
        .for('update')
        .catch(rethrowQueryFailure);
      if (current === undefined)
        throw new Error('Connection test idempotency claim is unavailable');
      if (current.requestHash !== requestHash)
        throw new ConnectionIdempotencyConflictError(
          'Idempotency key request mismatch',
        );
      if (current.status === 'completed') {
        const result = parseConnectionTestResult(current.resultRef);
        if (
          result.connection.workspaceId !== workspaceId ||
          result.connection.id !== connectionId
        )
          throw new Error('Connection test idempotency result is corrupt');
        return Object.freeze({ kind: 'replay' as const, result });
      }
      const ownsClaim = inserted.length === 1;
      if (!ownsClaim) {
        if (
          current.status === 'in_progress' &&
          connectionTestClaimSchema.parse(current.resultRef).state ===
            'dispatched'
        )
          throw new ConnectionTestInProgressError(
            'Connection test has durable dispatch evidence',
          );
        if (current.status !== 'failed' && !current.stale)
          throw new ConnectionTestInProgressError(
            'Connection test is already in progress',
          );
        await db
          .update(records)
          .set({
            status: 'in_progress',
            resultRef: connectionTestClaim(dispatchToken, 'claimed'),
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(identity)
          .catch(rethrowQueryFailure);
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
