import { and, eq, getTableName, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  connections,
  idempotencyRecords as records,
  workspaces,
} from '@pertexo/database/schema';
import { SECOND_INTERVAL } from '../../shared/sql-intervals.repository.js';
import { connectionSecrets } from '../runtime/credentials.repository.js';
import { CONNECTION_TEST_CLAIM_STALE_SECONDS } from './claim.js';

import { connectionCommandScope, keyDigest } from '../receipts.js';

export const CONNECTION_TEST_OPERATION = 'connection.test';

/** Where one test's claim lives, and what proves a caller still owns it. */
export function connectionTestClaimRow(
  input: Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    idempotencyKey: string;
    requestHash: string;
    dispatchToken: string;
  }>,
) {
  const scope = connectionCommandScope(input.actorId, input.connectionId);
  const digest = keyDigest(input.idempotencyKey);
  const identity = and(
    eq(records.workspaceId, input.workspaceId),
    eq(records.operation, CONNECTION_TEST_OPERATION),
    eq(records.scope, scope),
    eq(records.keyHash, digest),
  );
  const ownership = and(
    identity,
    eq(records.requestHash, input.requestHash),
    eq(records.status, 'in_progress'),
    sql`${records.resultRef}->>'dispatchToken'=${input.dispatchToken}`,
  );
  return {
    scope,
    digest,
    identity,
    ownership,
    stillClaimed: and(ownership, sql`${records.resultRef}->>'state'='claimed'`),
  };
}

/** The claim's stored result, locked, or undefined when the caller no longer owns it. */
export async function lockClaimResult(
  client: PoolClient,
  where: SQL | undefined,
): Promise<Readonly<{ resultRef: unknown }> | undefined> {
  const [claim] = await drizzle(client)
    .select({ resultRef: records.resultRef })
    .from(records)
    .where(where)
    .for('update')
    .catch(rethrowQueryFailure);
  return claim === undefined ? undefined : { resultRef: claim.resultRef };
}

/** Whether exactly one claim matches, locking it. */
export async function lockOneClaim(
  client: PoolClient,
  where: SQL | undefined,
): Promise<boolean> {
  const claim = await drizzle(client)
    .select({ id: records.id })
    .from(records)
    .where(where)
    .for('update')
    .catch(rethrowQueryFailure);
  return claim.length === 1;
}

export async function setClaimResult(
  client: PoolClient,
  where: SQL | undefined,
  resultRef: unknown,
): Promise<void> {
  await drizzle(client)
    .update(records)
    .set({ resultRef, updatedAt: sql`transaction_timestamp()` })
    .where(where)
    .catch(rethrowQueryFailure);
}

/** Stores a new claim result; false when no claim still matched. */
export async function storeClaimResult(
  client: PoolClient,
  where: SQL | undefined,
  resultRef: unknown,
): Promise<boolean> {
  const stored = await drizzle(client)
    .update(records)
    .set({ resultRef, updatedAt: sql`transaction_timestamp()` })
    .where(where)
    .returning({ id: records.id })
    .catch(rethrowQueryFailure);
  return stored.length === 1;
}

export async function completeClaim(
  client: PoolClient,
  where: SQL | undefined,
  resultRef: unknown,
): Promise<void> {
  await drizzle(client)
    .update(records)
    .set({
      status: 'completed',
      resultRef,
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(where)
    .catch(rethrowQueryFailure);
}

/** Whether this call created the claim; an existing one is left as it is. */
export async function insertClaim(
  client: PoolClient,
  claim: Readonly<{
    workspaceId: string;
    scope: string;
    digest: string;
    requestHash: string;
    connectionId: string;
    resultRef: unknown;
  }>,
): Promise<boolean> {
  const inserted = await drizzle(client)
    .insert(records)
    .values({
      id: generatePersistedId(),
      workspaceId: claim.workspaceId,
      operation: CONNECTION_TEST_OPERATION,
      scope: claim.scope,
      keyHash: claim.digest,
      requestHash: claim.requestHash,
      status: 'in_progress',
      resourceId: claim.connectionId,
      resultRef: claim.resultRef,
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
  return inserted.length === 1;
}

/** The claim under this key, locked, with whether it has gone stale. */
export async function lockClaimState(
  client: PoolClient,
  where: SQL | undefined,
) {
  const [current] = await drizzle(client)
    .select({
      requestHash: records.requestHash,
      status: records.status,
      resultRef: records.resultRef,
      stale: sql<boolean>`${records.updatedAt}<transaction_timestamp()-${CONNECTION_TEST_CLAIM_STALE_SECONDS}*${SECOND_INTERVAL}`,
    })
    .from(records)
    .where(where)
    .for('update')
    .catch(rethrowQueryFailure);
  return current;
}

export async function reopenClaim(
  client: PoolClient,
  where: SQL | undefined,
  resultRef: unknown,
): Promise<void> {
  await drizzle(client)
    .update(records)
    .set({
      status: 'in_progress',
      resultRef,
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(where)
    .catch(rethrowQueryFailure);
}

export async function readWorkspaceStatus(
  client: PoolClient,
  workspaceId: string,
): Promise<string | undefined> {
  const [workspace] = await drizzle(client)
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .catch(rethrowQueryFailure);
  return workspace?.status;
}

export async function readHealthRevision(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
): Promise<string | undefined> {
  const [revision] = await drizzle(client)
    .select({
      healthRevision: sql<string>`${connections.healthRevision}::text`,
    })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, connectionId),
      ),
    )
    .catch(rethrowQueryFailure);
  return revision?.healthRevision;
}

/** The provider's live connection with its current sealed secret, share-locked. */
export async function lockTestSecret(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
  providerKey: string,
) {
  // PostgreSQL OF targets use the unqualified relation name.
  const connectionLock = alias(connections, getTableName(connections));
  const [row] = await connectionSecrets(drizzle(client))
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, connectionId),
        eq(connections.providerKey, providerKey),
        sql`${connections.status}<>'revoked'`,
      ),
    )
    .for('share', { of: connectionLock })
    .catch(rethrowQueryFailure);
  return row;
}
