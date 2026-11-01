import type { PoolClient } from 'pg';

import {
  claimCommand,
  completeCommand,
  findCommandResult,
} from '@pertexo/database/primitives';

import type {
  ConnectionRecord,
  FindConnectionRotateReplayInput,
  RotateConnectionSecretInput,
} from '../contract.js';
import {
  CONNECTION_AUTH_TYPE,
  CONNECTION_EVENT_TYPE,
  CONNECTION_STATUS,
  ConnectionNotFoundError,
  ConnectionSecretVersionConflictError,
  ConnectionUnavailableError,
} from '../contract.js';
import { recordMemberAction } from '../events.repository.js';
import { healthOfNewSecret } from '../health/rules.js';
import { rotateConnectionHealth } from '../health/transitions.repository.js';
import {
  deleteOAuth2Grant,
  insertOAuth2Client,
  withOneOAuth2Fact,
} from '../oauth2/clients.repository.js';
import {
  connectionCommand,
  connectionCommandScope,
  decodeDurableConnectionReplay,
  serializeConnectionSnapshot,
} from '../receipts.js';
import { selectConnection } from '../records.queries.js';
import { insertSecretVersion } from './secret-version.repository.js';

const ROTATE_OPERATION = 'connection.secret.rotate';

export async function findConnectionRotateReplay(
  client: PoolClient,
  input: FindConnectionRotateReplayInput,
): Promise<ConnectionRecord | null> {
  const { workspaceId, actorId, connectionId } = input;
  const stored = await findCommandResult(
    client,
    connectionCommand(
      input,
      workspaceId,
      ROTATE_OPERATION,
      connectionCommandScope(actorId, connectionId),
    ),
  );
  return stored === null ? null : decodeRotateReplay(stored, input);
}

/** Refuses anything but the version the caller read, so two rotations can't race. */
export async function rotateConnectionSecret(
  client: PoolClient,
  input: RotateConnectionSecretInput,
): Promise<ConnectionRecord> {
  const { workspaceId, actorId, connectionId, secretVersionId, sealed } = input;
  const expected = input.expectedCurrentSecretVersionId;
  const authType = input.expectedAuthType ?? CONNECTION_AUTH_TYPE.httpHeaders;
  const command = connectionCommand(
    input,
    workspaceId,
    ROTATE_OPERATION,
    connectionCommandScope(actorId, connectionId),
  );
  const stored = await claimCommand(client, {
    ...command,
    resourceId: connectionId,
  });
  if (stored !== null) return decodeRotateReplay(stored, input);
  const connection = await selectConnection(client, workspaceId, connectionId, {
    lock: true,
  });
  if (connection === null)
    throw new ConnectionNotFoundError('Connection is not visible');
  if (connection.status === CONNECTION_STATUS.revoked)
    throw new ConnectionUnavailableError('Connection is revoked');
  if (connection.authType !== authType)
    throw new ConnectionUnavailableError(
      'Connection authentication type cannot be changed by rotation',
    );
  if (connection.currentSecretVersionId !== expected)
    throw new ConnectionSecretVersionConflictError(
      'Connection secret version does not match',
    );
  await insertSecretVersion(client, {
    workspaceId,
    connectionId,
    secretVersionId,
    sealed,
    createdBy: actorId,
  });
  if (input.expectedAuthType === CONNECTION_AUTH_TYPE.oauth2) {
    await insertOAuth2Client(client, {
      workspaceId,
      connectionId,
      secretVersionId,
      settings: input.oauth2Settings,
    });
    await deleteOAuth2Grant(client, workspaceId, connectionId);
  }
  const updated = await rotateConnectionHealth(
    client,
    workspaceId,
    connectionId,
    { secretVersionId, ...healthOfNewSecret(authType) },
  );
  await recordMemberAction(client, {
    workspaceId,
    connectionId,
    eventType: CONNECTION_EVENT_TYPE.secretRotated,
    actorId,
    requestId: input.requestId,
    traceId: input.traceId,
    metadata: { previousSecretVersionId: expected, secretVersionId },
  });
  const row = updated[0];
  if (row === undefined) throw new Error('Connection rotation returned no row');
  const rotated = await withOneOAuth2Fact(
    client,
    workspaceId,
    Object.freeze(row),
  );
  await completeCommand(client, command, serializeConnectionSnapshot(rotated));
  return rotated;
}

function decodeRotateReplay(
  stored: unknown,
  input: Readonly<{ workspaceId: string; connectionId: string }>,
): ConnectionRecord {
  const replay = decodeDurableConnectionReplay(stored);
  if (
    replay.id !== input.connectionId ||
    replay.workspaceId !== input.workspaceId
  )
    throw new Error('Connection rotation idempotency result is corrupt');
  return replay;
}
