import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { connections } from '../../schema/connections.js';
import { workspaces } from '../../schema/foundation.js';
import { connectionSecrets } from './credentials.queries.js';
import type { Pool } from 'pg';
import { z } from 'zod';

import {
  isConnectionFenceCurrent,
  recordCredentialAccess,
} from './dispatch.repository.js';
import {
  uuidSchema,
  providerKeySchema,
  identifierSchema,
  safeOptionalIdentifier,
} from '../admission.js';
import { ConnectionUnavailableError } from '../contract.js';
import { withConnectionTransaction } from '../transactions.repository.js';
import type {
  ConnectionDatabase,
  ResolvedConnectionSecretRecord,
} from '../contract.js';

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
      const connectionId = uuidSchema.parse(input.connectionId);
      const expectedProviderKey = providerKeySchema.parse(
        input.expectedProviderKey,
      );
      const workerId = identifierSchema.parse(input.workerId);
      const purpose = z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z][a-z0-9._:-]{0,127}$/u)
        .parse(input.purpose);
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
          if (row === undefined)
            throw new ConnectionUnavailableError(
              'Connection is not available for credential use',
            );
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
