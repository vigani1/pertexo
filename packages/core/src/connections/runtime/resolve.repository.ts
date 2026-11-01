import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { connections, workspaces } from '@pertexo/database/schema';

import type {
  AssertConnectionSecretCurrentInput,
  ResolveConnectionSecretInput,
  ResolvedConnectionSecretRecord,
} from '../contract.js';
import {
  CONNECTION_AUTH_TYPE,
  CONNECTION_STATUS,
  ConnectionOAuth2NotConnectedError,
  ConnectionOAuth2RevokedError,
  ConnectionUnavailableError,
} from '../contract.js';
import { selectConnection } from '../records.queries.js';
import { withConnectionTransaction } from '../transaction.js';
import { connectionSecrets } from './credentials.queries.js';
import {
  isConnectionFenceCurrent,
  recordCredentialAccess,
} from './credential-use.repository.js';

/** A worker's credential, with its access audit fact: a run has no member behind it. */
export async function resolveConnectionSecret(
  pool: Pool,
  input: ResolveConnectionSecretInput,
): Promise<ResolvedConnectionSecretRecord> {
  const { workspaceId, connectionId, signal } = input;
  return withConnectionTransaction(
    pool,
    { workspaceId, signal },
    async (client) => {
      const [row] = await connectionSecrets(drizzle(client))
        .innerJoin(workspaces, eq(workspaces.id, connections.workspaceId))
        .where(
          and(
            eq(connections.workspaceId, workspaceId),
            eq(connections.id, connectionId),
            eq(connections.providerKey, input.expectedProviderKey),
            eq(connections.status, 'active'),
            eq(workspaces.status, 'active'),
          ),
        )
        .catch(rethrowQueryFailure);
      if (row === undefined) {
        const connection = await selectConnection(
          client,
          workspaceId,
          connectionId,
        );
        if (
          connection?.authType === CONNECTION_AUTH_TYPE.oauth2 &&
          connection.status === CONNECTION_STATUS.revoked
        )
          throw new ConnectionOAuth2RevokedError(
            'OAuth2 connection is revoked',
          );
        if (connection?.authType === CONNECTION_AUTH_TYPE.oauth2)
          throw new ConnectionOAuth2NotConnectedError(
            'OAuth2 connection has no usable grant',
          );
        throw new ConnectionUnavailableError(
          'Connection is not available for credential use',
        );
      }
      const connection = Object.freeze(row.connection);
      const secretVersionId = row.secretVersionId;
      if (secretVersionId !== connection.currentSecretVersionId)
        throw new Error('Connection secret pointer is corrupt');
      const current = await isConnectionFenceCurrent(client, workspaceId, {
        connectionId,
        providerKey: connection.providerKey,
        authType: connection.authType,
        secretVersionId,
      });
      if (!current)
        throw new ConnectionUnavailableError(
          'Connection changed before credential resolution',
        );
      await recordCredentialAccess(client, {
        workspaceId,
        connectionId,
        secretVersionId,
        workerId: input.workerId,
        traceId: input.traceId ?? null,
        purpose: input.purpose,
      });
      return Object.freeze({
        connection,
        secretVersionId,
        sealed: row.sealed,
      });
    },
  );
}

/** A worker asking whether the secret it holds may still be used. */
export async function assertConnectionSecretCurrent(
  pool: Pool,
  input: AssertConnectionSecretCurrentInput,
): Promise<void> {
  const { workspaceId, signal } = input;
  await withConnectionTransaction(
    pool,
    { workspaceId, signal },
    async (client) => {
      const result = await drizzle(client)
        .select({ id: connections.id })
        .from(connections)
        .innerJoin(workspaces, eq(workspaces.id, connections.workspaceId))
        .where(
          and(
            eq(connections.workspaceId, workspaceId),
            eq(connections.id, input.connectionId),
            eq(connections.providerKey, input.expectedProviderKey),
            eq(connections.authType, input.expectedAuthType),
            eq(connections.currentSecretVersionId, input.secretVersionId),
            eq(connections.status, 'active'),
            eq(workspaces.status, 'active'),
          ),
        )
        .catch(rethrowQueryFailure);
      if (result.length !== 1)
        throw new ConnectionUnavailableError(
          'Connection is not current for credential use',
        );
    },
  ).catch(rethrowQueryFailure);
}
