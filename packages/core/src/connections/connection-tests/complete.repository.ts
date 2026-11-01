import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { generatePersistedId } from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  connectionEvents,
  idempotencyRecords as records,
} from '@pertexo/database/schema';
import {
  keyDigest,
  parseRequestMetadata,
  serializeConnectionTestResult,
} from '../receipts.js';
import {
  CONNECTION_EVENT_TYPE,
  ConnectionNotFoundError,
  ConnectionTestInProgressError,
} from '../contract.js';
import { selectConnection } from '../records.queries.js';
import { withConnectionTransaction } from '../transaction.js';
import { connectionTestClaimSchema, connectionTestScope } from './claim.js';

import { applyCurrentConnectionTestHealth } from '../health/transitions.repository.js';
import { withOneOAuth2Fact } from '../oauth2/clients.repository.js';

import { classifyConnectionTestCompletion } from '@pertexo/workflow-model';
import type { ConnectionTestPersistence } from './contract.js';

export async function completePersistedConnectionTest(
  pool: Pool,
  input: Parameters<ConnectionTestPersistence['completeConnectionTest']>[0],
): ReturnType<ConnectionTestPersistence['completeConnectionTest']> {
  const actorId = input.actorId;
  const connectionId = input.connectionId;
  const requestHash = input.requestHash;
  const dispatchToken = input.dispatchToken;
  const secretVersionId = input.secretVersionId;
  const digest = keyDigest(input.idempotencyKey);
  const scope = connectionTestScope(actorId, connectionId);
  const metadata = parseRequestMetadata(input);
  const outcome = input.outcome;
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
      const connection = await withOneOAuth2Fact(
        client,
        workspaceId,
        await applyCurrentConnectionTestHealth(client, {
          current,
          secretVersionId,
          healthRevision: claimState.healthRevision,
          outcome,
          actorId,
          ...metadata,
        }),
      );
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
