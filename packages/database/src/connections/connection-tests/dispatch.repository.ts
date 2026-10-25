import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { connections } from '../../schema/connections.js';
import { auditEvents } from '../../schema/foundation.js';
import { idempotencyRecords as records } from '../../schema/runs/support.js';

import { generatePersistedId } from '../../platform/persisted-id.js';
import { keyDigest, parseRequestMetadata } from '../admission.js';
import { requireConnectionUser } from '../authority.queries.js';
import type { MarkConnectionTestDispatchedInput } from '../contract.js';
import {
  CONNECTION_STATUS,
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

export async function markConnectionTestDispatched(
  pool: Pool,
  input: MarkConnectionTestDispatchedInput,
): Promise<void> {
  const actorId = input.actorId;
  const connectionId = input.connectionId;
  const secretVersionId = input.secretVersionId;
  const requestHash = input.requestHash;
  const dispatchToken = input.dispatchToken;
  const digest = keyDigest(input.idempotencyKey);
  const scope = connectionTestScope(actorId, connectionId);
  const metadata = parseRequestMetadata(input);
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
      await requireConnectionUser(client, workspaceId, actorId, connectionId);
      const ownership = and(
        identity,
        eq(records.requestHash, requestHash),
        eq(records.status, 'in_progress'),
        sql`${records.resultRef}->>'dispatchToken'=${dispatchToken}`,
      );
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
      if (
        connectionTestClaimSchema.parse(claimRow.resultRef).state !== 'claimed'
      )
        throw new ConnectionTestInProgressError(
          'Connection test already has durable dispatch evidence',
        );
      const connection = await selectConnection(
        client,
        workspaceId,
        connectionId,
        { lock: true },
      );
      const connectionUnavailable =
        connection === null ||
        connection.status === CONNECTION_STATUS.revoked ||
        connection.currentSecretVersionId !== secretVersionId;
      if (connectionUnavailable)
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
        .where(and(ownership, sql`${records.resultRef}->>'state'='claimed'`))
        .returning({ id: records.id })
        .catch(rethrowQueryFailure);
      if (marked.length !== 1)
        throw new ConnectionTestInProgressError(
          'Connection test dispatch ownership was lost',
        );
      await db
        .insert(auditEvents)
        .values({
          id: generatePersistedId(),
          workspaceId,
          actorUserId: actorId,
          action: 'connection.test_dispatched',
          targetType: 'connection',
          targetId: connectionId,
          requestId: metadata.requestId,
          traceId: metadata.traceId,
          metadata: { secretVersionId },
        })
        .catch(rethrowQueryFailure);
    },
  }).catch(rethrowQueryFailure);
}
