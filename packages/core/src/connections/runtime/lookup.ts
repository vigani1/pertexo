import { isConnectionFenceCurrent } from './credential-use.repository.js';
import type { ConnectionFence } from './connection-resolution.types.js';
import type { PoolClient } from 'pg';

import type { ResolvedConnectionSecretRecord } from '../connection.types.js';

import {
  CONNECTION_EVENT_TYPE,
  CONNECTION_STATUS,
} from '@pertexo/workflow-model';

import {
  ConnectionNotFoundError,
  ConnectionUnavailableError,
} from '../connection.errors.js';

import { recordMemberAction } from '../events.repository.js';

import { selectConnection } from '../connections.repository.js';

import { readSealedSecret } from './lookup.repository.js';

import type { ResolveConnectionLookupSecretInput } from './connection-resolution.types.js';

/**
 * The credential for an ADR 046 read-only provider lookup, with its access
 * audit fact. A lookup never changes connection health.
 */
export async function resolveConnectionLookupSecret(
  client: PoolClient,
  input: ResolveConnectionLookupSecretInput,
): Promise<ResolvedConnectionSecretRecord> {
  const { workspaceId, actorId, connectionId } = input;
  const connection = await requireLookupConnection(client, input);
  const row = await readSealedSecret(
    client,
    workspaceId,
    connectionId,
    connection.currentSecretVersionId,
  );
  if (row === undefined)
    throw new Error('Connection secret pointer is corrupt');
  await recordMemberAction(client, {
    workspaceId,
    connectionId,
    eventType: CONNECTION_EVENT_TYPE.credentialAccessed,
    actorId,
    requestId: input.requestId,
    traceId: input.traceId,
    metadata: {
      purpose: input.purpose,
      secretVersionId: connection.currentSecretVersionId,
    },
  });
  return Object.freeze({
    connection,
    secretVersionId: connection.currentSecretVersionId,
    sealed: row,
  });
}

export async function requireLookupConnection(
  client: PoolClient,
  input: Pick<
    ResolveConnectionLookupSecretInput,
    'workspaceId' | 'connectionId' | 'expectedProviderKey'
  >,
) {
  const { workspaceId, connectionId } = input;
  const connection = await selectConnection(client, workspaceId, connectionId);
  if (connection === null)
    throw new ConnectionNotFoundError('Connection is not visible');
  if (
    connection.providerKey !== input.expectedProviderKey ||
    connection.status !== CONNECTION_STATUS.active
  )
    throw new ConnectionUnavailableError(
      'Connection is not available for lookups',
      connection.status === CONNECTION_STATUS.revoked
        ? 'revoked'
        : 'unavailable',
    );
  return connection;
}

export async function assertLookupSecretCurrent(
  client: PoolClient,
  input: ConnectionFence &
    Readonly<{ workspaceId: string; actorId: string; signal: AbortSignal }>,
): Promise<void> {
  input.signal.throwIfAborted();
  if (!(await isConnectionFenceCurrent(client, input.workspaceId, input)))
    throw new ConnectionUnavailableError(
      'Connection changed before lookup dispatch',
      'settings_changed',
    );
}
