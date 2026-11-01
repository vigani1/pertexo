import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { generatePersistedId } from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { idempotencyRecords as records } from '@pertexo/database/schema';

import type {
  StartConnectionTestInput,
  StartConnectionTestResult,
} from '../contract.js';
import {
  CONNECTION_STATUS,
  ConnectionIdempotencyConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
} from '../contract.js';
import { parseConnectionTestResult } from '../receipts.js';
import { selectConnection } from '../records.queries.js';
import {
  CONNECTION_TEST_CLAIM_STALE_SECONDS,
  connectionTestClaim,
  connectionTestClaimSchema,
} from './claim.js';
import {
  connectionTestClaimRow,
  CONNECTION_TEST_OPERATION,
} from './claim.queries.js';

export async function startConnectionTest(
  client: PoolClient,
  input: StartConnectionTestInput,
): Promise<StartConnectionTestResult> {
  const { workspaceId, connectionId, requestHash, dispatchToken } = input;
  const { scope, digest, identity } = connectionTestClaimRow(input);
  const db = drizzle(client);
  const inserted = await db
    .insert(records)
    .values({
      id: generatePersistedId(),
      workspaceId,
      operation: CONNECTION_TEST_OPERATION,
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
      stale: sql<boolean>`${records.updatedAt}<transaction_timestamp()-${CONNECTION_TEST_CLAIM_STALE_SECONDS}*interval '1 second'`,
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
  if (inserted.length !== 1) {
    if (
      current.status === 'in_progress' &&
      connectionTestClaimSchema.parse(current.resultRef).state === 'dispatched'
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
  const connection = await selectConnection(client, workspaceId, connectionId);
  if (
    connection?.providerKey !== input.expectedProviderKey ||
    connection.status === CONNECTION_STATUS.revoked
  )
    throw new ConnectionUnavailableError(
      'Connection is not available for testing',
    );
  return Object.freeze({ kind: 'dispatch' as const, dispatchToken });
}
