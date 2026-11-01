import { and, eq, getTableName, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  connections,
  idempotencyRecords as records,
} from '@pertexo/database/schema';

import type {
  ResolveConnectionTestSecretInput,
  ResolvedConnectionSecretRecord,
} from '../contract.js';
import {
  CONNECTION_EVENT_TYPE,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
} from '../contract.js';
import { appendConnectionEvent } from '../events.repository.js';
import { withOneOAuth2Fact } from '../oauth2/clients.repository.js';
import { connectionSecrets } from '../runtime/credentials.queries.js';
import { connectionTestClaim } from './claim.js';
import {
  connectionTestClaimRow,
  CONNECTION_TEST_OPERATION,
} from './claim.queries.js';

export async function resolveConnectionTestSecret(
  client: PoolClient,
  input: ResolveConnectionTestSecretInput,
): Promise<ResolvedConnectionSecretRecord> {
  const { workspaceId, actorId, connectionId } = input;
  const { identity, stillClaimed } = connectionTestClaimRow(input);
  const db = drizzle(client);
  const claim = await db
    .select({ id: records.id })
    .from(records)
    .where(stillClaimed)
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
        eq(connections.providerKey, input.expectedProviderKey),
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
        input.dispatchToken,
        'claimed',
        secretVersionId,
        row.healthRevision,
      ),
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(identity)
    .catch(rethrowQueryFailure);
  await appendConnectionEvent(client, {
    workspaceId,
    connectionId,
    eventType: CONNECTION_EVENT_TYPE.credentialAccessed,
    actorKind: 'user',
    actorId,
    requestId: input.requestId,
    traceId: input.traceId,
    metadata: { purpose: CONNECTION_TEST_OPERATION, secretVersionId },
  });
  return Object.freeze({
    connection: await withOneOAuth2Fact(client, workspaceId, connection),
    secretVersionId,
    sealed: row.sealed,
  });
}
