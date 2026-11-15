import { decodeStoredValue } from '../../shared/stored-values.js';
import type { PoolClient } from 'pg';

import { appendAuditFact } from '../../governance/audit/facts.js';

import type { MarkConnectionTestDispatchedInput } from '../connection.types.js';
import { CONNECTION_STATUS } from '@pertexo/workflow-model';
import {
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
} from '../connection.errors.js';
import { selectConnection } from '../connections.repository.js';
import { connectionTestClaim, connectionTestClaimSchema } from './claim.js';
import {
  connectionTestClaimRow,
  lockClaimResult,
  readHealthRevision,
  storeClaimResult,
} from './claim.repository.js';

export async function markConnectionTestDispatched(
  client: PoolClient,
  input: MarkConnectionTestDispatchedInput,
): Promise<void> {
  const { workspaceId, actorId, connectionId, secretVersionId } = input;
  const { dispatchToken } = input;
  const { ownership, stillClaimed } = connectionTestClaimRow(input);
  const claimRow = await lockClaimResult(client, ownership);
  if (claimRow === undefined)
    throw new ConnectionTestInProgressError(
      'Connection test dispatch ownership was lost',
    );
  if (
    decodeStoredValue(() => connectionTestClaimSchema.parse(claimRow.resultRef))
      .state !== 'claimed'
  )
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
      connection?.status === CONNECTION_STATUS.revoked
        ? 'revoked'
        : 'settings_changed',
    );
  const healthRevision = await readHealthRevision(
    client,
    workspaceId,
    connectionId,
  );
  if (healthRevision === undefined)
    throw new ConnectionUnavailableError(
      'Connection health revision is unavailable',
      'unavailable',
    );
  const marked = await storeClaimResult(
    client,
    stillClaimed,
    connectionTestClaim(
      dispatchToken,
      'dispatched',
      secretVersionId,
      healthRevision,
    ),
  );
  if (!marked)
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
