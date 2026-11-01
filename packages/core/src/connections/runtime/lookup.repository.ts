import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  appendAuditFact,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import { generatePersistedId } from '@pertexo/database/platform';
import {
  connectionEvents,
  connectionSecretVersions,
} from '@pertexo/database/schema';
import { sealedFields } from '../records.queries.js';
import type { ConnectionLookupDatabase } from './contract.js';

import type { Pool } from 'pg';
import { parseRequestMetadata } from '../admission.js';
import { requireConnectionUser } from '../authority.queries.js';
import {
  CONNECTION_EVENT_TYPE,
  CONNECTION_STATUS,
  ConnectionNotFoundError,
  ConnectionUnavailableError,
} from '../contract.js';
import { selectConnection } from '../records.queries.js';
import { withConnectionTransaction } from '../transactions.repository.js';

export function createConnectionLookupPersistence(
  pool: Pool,
): ConnectionLookupDatabase {
  return Object.freeze({
    resolveConnectionLookupSecret: async (input) => {
      const actorId = input.actorId;
      const connectionId = input.connectionId;
      const expectedProviderKey = input.expectedProviderKey;
      const purpose = input.purpose;
      const metadata = parseRequestMetadata(input);
      return withConnectionTransaction(pool, input.workspaceId, {
        actorId,
        operation: async (client, workspaceId) => {
          await requireConnectionUser(
            client,
            workspaceId,
            actorId,
            connectionId,
          );
          const connection = await selectConnection(
            client,
            workspaceId,
            connectionId,
          );
          if (connection === null)
            throw new ConnectionNotFoundError('Connection is not visible');
          if (
            connection.providerKey !== expectedProviderKey ||
            connection.status !== CONNECTION_STATUS.active
          )
            throw new ConnectionUnavailableError(
              'Connection is not available for lookups',
            );
          const db = drizzle(client);
          const [row] = await db
            .select(sealedFields)
            .from(connectionSecretVersions)
            .where(
              and(
                eq(connectionSecretVersions.workspaceId, workspaceId),
                eq(connectionSecretVersions.connectionId, connectionId),
                eq(
                  connectionSecretVersions.id,
                  connection.currentSecretVersionId,
                ),
              ),
            )
            .catch(rethrowQueryFailure);
          if (row === undefined)
            throw new Error('Connection secret pointer is corrupt');
          await db
            .insert(connectionEvents)
            .values({
              id: generatePersistedId(),
              workspaceId,
              connectionId,
              eventType: CONNECTION_EVENT_TYPE.credentialAccessed,
              actorKind: 'user',
              actorId,
              requestId: metadata.requestId,
              traceId: metadata.traceId,
              metadata: {
                purpose,
                secretVersionId: connection.currentSecretVersionId,
              },
            })
            .catch(rethrowQueryFailure);
          await appendAuditFact(client, {
            workspaceId,
            actorId,
            action: 'connection.credential_accessed',
            targetType: 'connection',
            targetId: connectionId,
            ...metadata,
            metadata: {
              purpose,
              secretVersionId: connection.currentSecretVersionId,
            },
          });
          return Object.freeze({
            connection,
            secretVersionId: connection.currentSecretVersionId,
            sealed: row,
          });
        },
        options: input.signal === undefined ? {} : { signal: input.signal },
      });
    },
  });
}
