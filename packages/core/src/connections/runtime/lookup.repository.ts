import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { connectionSecretVersions } from '@pertexo/database/schema';

import type { ResolvedConnectionSecretRecord } from '../contract.js';
import {
  CONNECTION_EVENT_TYPE,
  CONNECTION_STATUS,
  ConnectionNotFoundError,
  ConnectionUnavailableError,
} from '../contract.js';
import { recordMemberAction } from '../events.repository.js';
import { sealedFields, selectConnection } from '../records.queries.js';
import type { ResolveConnectionLookupSecretInput } from './contract.js';

/**
 * The credential for an ADR 046 read-only provider lookup, with its access
 * audit fact. A lookup never changes connection health.
 */
export async function resolveConnectionLookupSecret(
  client: PoolClient,
  input: ResolveConnectionLookupSecretInput,
): Promise<ResolvedConnectionSecretRecord> {
  const { workspaceId, actorId, connectionId } = input;
  const connection = await selectConnection(client, workspaceId, connectionId);
  if (connection === null)
    throw new ConnectionNotFoundError('Connection is not visible');
  if (
    connection.providerKey !== input.expectedProviderKey ||
    connection.status !== CONNECTION_STATUS.active
  )
    throw new ConnectionUnavailableError(
      'Connection is not available for lookups',
    );
  const [row] = await drizzle(client)
    .select(sealedFields)
    .from(connectionSecretVersions)
    .where(
      and(
        eq(connectionSecretVersions.workspaceId, workspaceId),
        eq(connectionSecretVersions.connectionId, connectionId),
        eq(connectionSecretVersions.id, connection.currentSecretVersionId),
      ),
    )
    .catch(rethrowQueryFailure);
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
