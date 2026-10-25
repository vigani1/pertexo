import { and, eq, getTableName, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { connectionEvents, connections } from '../../schema/connections.js';
import { idempotencyRecords as records } from '../../schema/runs/support.js';
import { keyDigest, parseRequestMetadata } from '../admission.js';
import { requireConnectionUser } from '../authority.queries.js';
import {
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
} from '../contract.js';
import { connectionSecrets } from '../runtime/credentials.queries.js';
import { withConnectionTransaction } from '../transactions.repository.js';
import { connectionTestClaim, connectionTestScope } from './claim.js';

import type { ConnectionTestPersistence } from './contract.js';

export async function resolvePersistedConnectionTestSecret(
  pool: Pool,
  input: Parameters<
    ConnectionTestPersistence['resolveConnectionTestSecret']
  >[0],
): ReturnType<ConnectionTestPersistence['resolveConnectionTestSecret']> {
  const actorId = input.actorId;
  const connectionId = input.connectionId;
  const expectedProviderKey = input.expectedProviderKey;
  const requestHash = input.requestHash;
  const dispatchToken = input.dispatchToken;
  const digest = keyDigest(input.idempotencyKey);
  const scope = connectionTestScope(actorId, connectionId);
  const metadata = parseRequestMetadata(input);
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
      const claim = await db
        .select({ id: records.id })
        .from(records)
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
        .for('update')
        .catch(rethrowQueryFailure);
      if (claim.length !== 1)
        throw new ConnectionTestInProgressError(
          'Connection test credential ownership was lost',
        );
      // PostgreSQL OF targets use the unqualified relation name.
      const connectionLock = alias(connections, getTableName(connections));
      const [row] = await connectionSecrets(db)
        .where(
          and(
            eq(connections.workspaceId, workspaceId),
            eq(connections.id, connectionId),
            eq(connections.providerKey, expectedProviderKey),
            sql`${connections.status}<>'revoked'`,
          ),
        )
        .for('share', { of: connectionLock })
        .catch(rethrowQueryFailure);
      if (row === undefined)
        throw new ConnectionUnavailableError(
          'Connection is not available for testing',
        );
      const connection = Object.freeze(row.connection);
      const secretVersionId = row.secretVersionId;
      if (secretVersionId !== connection.currentSecretVersionId)
        throw new Error('Connection secret pointer is corrupt');
      // DNS and safety checks may fail before dispatch. Capture their
      // current-credential fence now, without inventing dispatch evidence.
      await db
        .update(records)
        .set({
          resultRef: connectionTestClaim(
            dispatchToken,
            'claimed',
            secretVersionId,
            row.healthRevision,
          ),
          updatedAt: sql`transaction_timestamp()`,
        })
        .where(identity)
        .catch(rethrowQueryFailure);
      await db
        .insert(connectionEvents)
        .values({
          id: generatePersistedId(),
          workspaceId,
          connectionId,
          eventType: 'connection.credential_accessed',
          actorKind: 'user',
          actorId,
          requestId: metadata.requestId,
          traceId: metadata.traceId,
          metadata: { purpose: 'connection.test', secretVersionId },
        })
        .catch(rethrowQueryFailure);
      return Object.freeze({
        connection,
        secretVersionId,
        sealed: row.sealed,
      });
    },
  });
}
