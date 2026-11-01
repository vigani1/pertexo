import { classifyConnectionTestCompletion } from '@pertexo/workflow-model';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  idempotencyRecords as records,
  workspaces,
} from '@pertexo/database/schema';

import type {
  CompleteConnectionTestInput,
  ConnectionTestResult,
} from '../contract.js';
import {
  CONNECTION_EVENT_TYPE,
  ConnectionNotFoundError,
  ConnectionTestInProgressError,
} from '../contract.js';
import { appendConnectionEvent } from '../events.repository.js';
import { applyCurrentConnectionTestHealth } from '../health/transitions.repository.js';
import { withOneOAuth2Fact } from '../oauth2/clients.repository.js';
import { serializeConnectionTestResult } from '../receipts.js';
import { selectConnection } from '../records.queries.js';
import { withConnectionTransaction } from '../transaction.js';
import {
  completionNeedsDispatchEvidence,
  connectionTestClaimSchema,
} from './claim.js';
import { connectionTestClaimRow } from './claim.queries.js';

/**
 * Owning the claim is the authority: a test that started under current access
 * still reports what it found if the member has lost that access since.
 */
export async function completeConnectionTest(
  pool: Pool,
  input: CompleteConnectionTestInput,
): Promise<ConnectionTestResult> {
  const { workspaceId, actorId, connectionId, secretVersionId, outcome } =
    input;
  const { identity, ownership } = connectionTestClaimRow(input);
  return withConnectionTransaction(pool, input, async (client) => {
    const db = drizzle(client);
    const [claim] = await db
      .select({ resultRef: records.resultRef })
      .from(records)
      .where(ownership)
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
    if (
      completionNeedsDispatchEvidence(outcome) &&
      claimState.state !== 'dispatched'
    )
      throw new ConnectionTestInProgressError(
        'Connection test has no dispatch evidence',
      );
    const current = await selectConnection(client, workspaceId, connectionId, {
      lock: true,
    });
    if (current === null)
      throw new ConnectionNotFoundError('Connection is not visible');
    const classification = classifyConnectionTestCompletion(
      current.status,
      outcome,
      secretVersionId,
      {
        currentSecretWasTested:
          current.currentSecretVersionId === secretVersionId,
      },
    );
    // Integrations stay off outside an active workspace, so a test that finishes
    // after the workspace left that state reports what it found and changes nothing.
    const [workspace] = await db
      .select({ status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .catch(rethrowQueryFailure);
    const connection = await withOneOAuth2Fact(
      client,
      workspaceId,
      workspace?.status === 'active'
        ? await applyCurrentConnectionTestHealth(client, {
            current,
            secretVersionId,
            healthRevision: claimState.healthRevision,
            outcome,
            actorId,
            requestId: input.requestId,
            traceId: input.traceId,
          })
        : current,
    );
    await appendConnectionEvent(client, {
      workspaceId,
      connectionId,
      eventType: outcome.ok
        ? CONNECTION_EVENT_TYPE.testSucceeded
        : CONNECTION_EVENT_TYPE.testFailed,
      actorKind: 'user',
      actorId,
      requestId: input.requestId,
      traceId: input.traceId,
      metadata: classification.eventMetadata,
    });
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
  });
}
