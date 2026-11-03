import { and, eq, sql } from 'drizzle-orm';

import { idempotencyRecords as records } from '@pertexo/database/schema';

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
