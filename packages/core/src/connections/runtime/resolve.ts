import type { Pool } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';

import type {
  AssertConnectionSecretCurrentInput,
  ResolveConnectionSecretInput,
  ResolvedConnectionSecretRecord,
} from '../connection.types.js';
import {
  CONNECTION_AUTH_TYPE,
  CONNECTION_STATUS,
} from '@pertexo/workflow-model';
import {
  ConnectionOAuth2NotConnectedError,
  ConnectionOAuth2RevokedError,
  ConnectionUnavailableError,
} from '../connection.errors.js';
import { selectConnection } from '../connections.repository.js';
import { withConnectionTransaction } from '../transaction.js';
import { readUsableSecret, secretStillCurrent } from './resolve.repository.js';
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
      const row = await readUsableSecret(client, input);
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
          'unavailable',
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
          'settings_changed',
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
      if (!(await secretStillCurrent(client, input)))
        throw new ConnectionUnavailableError(
          'Connection is not current for credential use',
          'settings_changed',
        );
    },
  ).catch(rethrowQueryFailure);
}
