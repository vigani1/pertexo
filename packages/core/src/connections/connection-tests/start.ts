import { decodeStoredValue } from '../../shared/stored-values.js';
import type { PoolClient } from 'pg';

import type {
  StartConnectionTestInput,
  StartConnectionTestResult,
} from '../connection.types.js';
import { CONNECTION_STATUS } from '@pertexo/workflow-model';
import {
  ConnectionIdempotencyConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
} from '../connection.errors.js';
import { parseConnectionTestResult } from '../receipts.js';
import { selectConnection } from '../connections.repository.js';
import { connectionTestClaim, connectionTestClaimSchema } from './claim.js';
import {
  connectionTestClaimRow,
  insertClaim,
  lockClaimState,
  reopenClaim,
} from './claim.repository.js';

export async function startConnectionTest(
  client: PoolClient,
  input: StartConnectionTestInput,
): Promise<StartConnectionTestResult> {
  const { workspaceId, connectionId, requestHash, dispatchToken } = input;
  const { scope, digest, identity } = connectionTestClaimRow(input);
  const inserted = await insertClaim(client, {
    workspaceId,
    scope,
    digest,
    requestHash,
    connectionId,
    resultRef: connectionTestClaim(dispatchToken, 'claimed'),
  });
  const current = await lockClaimState(client, identity);
  if (current === undefined)
    throw new Error('Connection test idempotency claim is unavailable');
  if (current.requestHash !== requestHash)
    throw new ConnectionIdempotencyConflictError(
      'Idempotency key request mismatch',
    );
  if (current.status === 'completed') {
    const result = parseConnectionTestResult(current.resultRef);
    if (
      result.connection.workspaceId !== workspaceId ||
      result.connection.id !== connectionId
    )
      throw new Error('Connection test idempotency result is corrupt');
    return Object.freeze({ kind: 'replay' as const, result });
  }
  if (!inserted) {
    if (
      current.status === 'in_progress' &&
      decodeStoredValue(() =>
        connectionTestClaimSchema.parse(current.resultRef),
      ).state === 'dispatched'
    )
      throw new ConnectionTestInProgressError(
        'Connection test has durable dispatch evidence',
      );
    if (current.status !== 'failed' && !current.stale)
      throw new ConnectionTestInProgressError(
        'Connection test is already in progress',
      );
    await reopenClaim(
      client,
      identity,
      connectionTestClaim(dispatchToken, 'claimed'),
    );
  }
  const connection = await selectConnection(client, workspaceId, connectionId);
  if (
    connection?.providerKey !== input.expectedProviderKey ||
    connection.status === CONNECTION_STATUS.revoked
  )
    throw new ConnectionUnavailableError(
      'Connection is not available for testing',
      connection?.status === CONNECTION_STATUS.revoked
        ? 'revoked'
        : 'unavailable',
    );
  return Object.freeze({ kind: 'dispatch' as const, dispatchToken });
}
