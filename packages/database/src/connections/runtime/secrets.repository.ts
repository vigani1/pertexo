import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { connections } from '../../schema/connections.js';
import { workspaces } from '../../schema/foundation.js';
import { connectionSecrets } from './credentials.queries.js';

import { safeOptionalIdentifier } from '../admission.js';
import type {
  ConnectionDatabase,
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
import { withConnectionTransaction } from '../transactions.repository.js';
import {
  isConnectionFenceCurrent,
  recordCredentialAccess,
} from './dispatch.repository.js';

/** Owns worker credential resolution and its access audit fact. */

export type ConnectionResolutionPersistence = Pick<
  ConnectionDatabase,
  'resolveConnectionSecret'
>;

export function createConnectionResolutionPersistence(
  pool: Pool,
): ConnectionResolutionPersistence {
  return Object.freeze({
    resolveConnectionSecret: async (
      input,
    ): Promise<ResolvedConnectionSecretRecord> => {
      const connectionId = input.connectionId;
      const expectedProviderKey = input.expectedProviderKey;
      const workerId = input.workerId;
      const purpose = input.purpose;
      const traceId = safeOptionalIdentifier(input.traceId);
      return withConnectionTransaction(pool, input.workspaceId, {
        actorId: undefined,
        operation: async (client, workspaceId) => {
          const [row] = await connectionSecrets(drizzle(client))
            .innerJoin(workspaces, eq(workspaces.id, connections.workspaceId))
            .where(
              and(
                eq(connections.workspaceId, workspaceId),
                eq(connections.id, connectionId),
                eq(connections.providerKey, expectedProviderKey),
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
            workerId,
            traceId,
            purpose,
          });
          return Object.freeze({
            connection,
            secretVersionId,
            sealed: row.sealed,
          });
        },
        options: input.signal === undefined ? {} : { signal: input.signal },
      });
    },
  });
}
