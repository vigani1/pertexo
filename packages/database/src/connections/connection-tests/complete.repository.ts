import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { connectionEvents } from '../../schema/connections.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { idempotencyRecords as records } from '../../schema/runs/support.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import type { Pool } from 'pg';
import {
  uuidSchema,
  CONNECTION_EVENT_TYPE,
  ConnectionNotFoundError,
  ConnectionTestInProgressError,
  keyDigest,
  withConnectionTransaction,
  parseRequestMetadata,
  selectConnection,
  connectionTestOutcomeSchema,
  serializeConnectionTestResult,
} from '../records.queries.js';
import { connectionTestClaimSchema, connectionTestScope } from './claim.js';

import { applyCurrentConnectionTestHealth } from '../health/transitions.repository.js';
import { sha256HexSchema as digestSchema } from '../../platform/persisted-primitives.js';

import { classifyConnectionTestCompletion } from './classify-completion.js';
import type { ConnectionTestPersistence } from './results.repository.js';

export async function completePersistedConnectionTest(
  pool: Pool,
  input: Parameters<ConnectionTestPersistence['completeConnectionTest']>[0],
): ReturnType<ConnectionTestPersistence['completeConnectionTest']> {
  const actorId = uuidSchema.parse(input.actorId);
  const connectionId = uuidSchema.parse(input.connectionId);
  const requestHash = digestSchema.parse(input.requestHash);
  const dispatchToken = uuidSchema.parse(input.dispatchToken);
  const secretVersionId = uuidSchema.parse(input.secretVersionId);
  const digest = keyDigest(input.idempotencyKey);
  const scope = connectionTestScope(actorId, connectionId);
  const metadata = parseRequestMetadata(input);
  const outcome = connectionTestOutcomeSchema.parse(input.outcome);
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
      const [claim] = await db
        .select({ resultRef: records.resultRef })
        .from(records)
        .where(
          and(
            identity,
            eq(records.requestHash, requestHash),
            eq(records.status, 'in_progress'),
            sql`${records.resultRef}->>'dispatchToken'=${dispatchToken}`,
          ),
        )
        .for('update')
        .catch(rethrowQueryFailure);
      if (claim === undefined)
        throw new ConnectionTestInProgressError(
          'Connection test completion ownership was lost',
        );
      const claimState = connectionTestClaimSchema.parse(claim.resultRef);
      if (
        claimState.secretVersionId !== undefined &&
        claimState.secretVersionId !== secretVersionId
      )
        throw new ConnectionTestInProgressError(
          'Connection test secret version does not match credential evidence',
        );
      const requiresDispatchedClaim =
        (outcome.ok ||
          outcome.httpStatus !== null ||
          outcome.reauthorizationRequired) &&
        claimState.state !== 'dispatched';
      if (requiresDispatchedClaim)
        throw new ConnectionTestInProgressError(
          'Connection test has no dispatch evidence',
        );
      const current = await selectConnection(
        client,
        workspaceId,
        connectionId,
        { lock: true },
      );
      if (current === null)
        throw new ConnectionNotFoundError('Connection is not visible');

      const currentSecretWasTested =
        current.currentSecretVersionId === secretVersionId;
      const classification = classifyConnectionTestCompletion(
        current.status,
        outcome,
        secretVersionId,
        { currentSecretWasTested },
      );
      const connection = await applyCurrentConnectionTestHealth(client, {
        current,
        secretVersionId,
        healthRevision: claimState.healthRevision,
        outcome,
        actorId,
        ...metadata,
      });
      await db
        .insert(connectionEvents)
        .values({
          id: generatePersistedId(),
          workspaceId,
          connectionId,
          eventType: outcome.ok
            ? CONNECTION_EVENT_TYPE.testSucceeded
            : CONNECTION_EVENT_TYPE.testFailed,
          actorKind: 'user',
          actorId,
          requestId: metadata.requestId,
          traceId: metadata.traceId,
          metadata: classification.eventMetadata,
        })
        .catch(rethrowQueryFailure);
      const result = Object.freeze({ connection, outcome });
      await db
        .update(records)
        .set({
          status: 'completed',
          resultRef: serializeConnectionTestResult(result),
          updatedAt: sql`transaction_timestamp()`,
        })
        .where(identity)
        .catch(rethrowQueryFailure);
      return result;
    },
  });
}
