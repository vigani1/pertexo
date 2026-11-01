import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import {
  appendAuditFact,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import {
  connections,
  idempotencyRecords as records,
} from '@pertexo/database/schema';

import type { MarkConnectionTestDispatchedInput } from '../contract.js';
import {
  CONNECTION_STATUS,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
} from '../contract.js';
import { selectConnection } from '../records.queries.js';
import { connectionTestClaim, connectionTestClaimSchema } from './claim.js';
import { connectionTestClaimRow } from './claim.queries.js';

export async function markConnectionTestDispatched(
  client: PoolClient,
  input: MarkConnectionTestDispatchedInput,
): Promise<void> {
  const { workspaceId, actorId, connectionId, secretVersionId } = input;
  const { dispatchToken } = input;
  const { ownership, stillClaimed } = connectionTestClaimRow(input);
  const db = drizzle(client);
  const [claimRow] = await db
    .select({ resultRef: records.resultRef })
    .from(records)
    .where(ownership)
    .for('update')
    .catch(rethrowQueryFailure);
  if (claimRow === undefined)
    throw new ConnectionTestInProgressError(
      'Connection test dispatch ownership was lost',
    );
  if (connectionTestClaimSchema.parse(claimRow.resultRef).state !== 'claimed')
    throw new ConnectionTestInProgressError(
      'Connection test already has durable dispatch evidence',
    );
  const connection = await selectConnection(client, workspaceId, connectionId, {
    lock: true,
  });
  if (
    connection === null ||
    connection.status === CONNECTION_STATUS.revoked ||
    connection.currentSecretVersionId !== secretVersionId
  )
    throw new ConnectionUnavailableError(
      'Connection changed before test dispatch',
    );
  const [revision] = await db
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
  const healthRevision = revision?.healthRevision;
  if (healthRevision === undefined)
    throw new ConnectionUnavailableError(
      'Connection health revision is unavailable',
    );
  const marked = await db
    .update(records)
    .set({
      resultRef: connectionTestClaim(
        dispatchToken,
        'dispatched',
        secretVersionId,
        healthRevision,
      ),
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(stillClaimed)
    .returning({ id: records.id })
    .catch(rethrowQueryFailure);
  if (marked.length !== 1)
    throw new ConnectionTestInProgressError(
      'Connection test dispatch ownership was lost',
    );
  await appendAuditFact(client, {
    workspaceId,
    actorId,
    action: 'connection.test_dispatched',
    targetType: 'connection',
    targetId: connectionId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata: { secretVersionId },
  });
}
