import type { PoolClient } from 'pg';

import type {
  ResolveConnectionTestSecretInput,
  ResolvedConnectionSecretRecord,
} from '../connection.types.js';
import { CONNECTION_EVENT_TYPE } from '@pertexo/workflow-model';
import {
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
} from '../connection.errors.js';
import { appendConnectionEvent } from '../events.repository.js';
import { withOneOAuth2Fact } from '../oauth2/clients.repository.js';
import { connectionTestClaim } from './claim.js';
import {
  connectionTestClaimRow,
  CONNECTION_TEST_OPERATION,
  lockOneClaim,
  lockTestSecret,
  setClaimResult,
} from './claim.repository.js';

export async function resolveConnectionTestSecret(
  client: PoolClient,
  input: ResolveConnectionTestSecretInput,
): Promise<ResolvedConnectionSecretRecord> {
  const { workspaceId, actorId, connectionId } = input;
  const { identity, stillClaimed } = connectionTestClaimRow(input);
  if (!(await lockOneClaim(client, stillClaimed)))
    throw new ConnectionTestInProgressError(
      'Connection test credential ownership was lost',
    );
  const row = await lockTestSecret(
    client,
    workspaceId,
    connectionId,
    input.expectedProviderKey,
  );
  if (row === undefined)
    throw new ConnectionUnavailableError(
      'Connection is not available for testing',
      'unavailable',
    );
  const connection = Object.freeze(row.connection);
  const secretVersionId = row.secretVersionId;
  if (secretVersionId !== connection.currentSecretVersionId)
    throw new Error('Connection secret pointer is corrupt');
  // DNS and safety checks may fail before dispatch. Capture their
  // current-credential fence now, without inventing dispatch evidence.
  await setClaimResult(
    client,
    identity,
    connectionTestClaim(
      input.dispatchToken,
      'claimed',
      secretVersionId,
      row.healthRevision,
    ),
  );
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
