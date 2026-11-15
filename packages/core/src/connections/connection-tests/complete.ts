import { decodeStoredValue } from '../../shared/stored-values.js';
import { classifyConnectionTestCompletion } from '../health/completion-policy.js';
import type { Pool } from 'pg';

import type {
  CompleteConnectionTestInput,
  ConnectionTestResult,
} from '../connection.types.js';
import { CONNECTION_EVENT_TYPE } from '@pertexo/workflow-model';
import {
  ConnectionNotFoundError,
  ConnectionTestInProgressError,
} from '../connection.errors.js';
import { appendConnectionEvent } from '../events.repository.js';
import { applyCurrentConnectionTestHealth } from '../health/transitions.repository.js';
import { withOneOAuth2Fact } from '../oauth2/clients.repository.js';
import { serializeConnectionTestResult } from '../receipts.js';
import { selectConnection } from '../connections.repository.js';
import { withConnectionTransaction } from '../transaction.js';
import {
  completionNeedsDispatchEvidence,
  connectionTestClaimSchema,
} from './claim.js';
import {
  completeClaim,
  connectionTestClaimRow,
  lockClaimResult,
  readWorkspaceStatus,
} from './claim.repository.js';

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
    const claim = await lockClaimResult(client, ownership);
    if (claim === undefined)
      throw new ConnectionTestInProgressError(
        'Connection test completion ownership was lost',
      );
    const claimState = decodeStoredValue(() =>
      connectionTestClaimSchema.parse(claim.resultRef),
    );
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
    const workspaceStatus = await readWorkspaceStatus(client, workspaceId);
    const connection = await withOneOAuth2Fact(
      client,
      workspaceId,
      workspaceStatus === 'active'
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
    await completeClaim(
      client,
      identity,
      serializeConnectionTestResult(result),
    );
    return result;
  });
}
