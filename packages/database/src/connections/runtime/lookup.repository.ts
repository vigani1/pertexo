import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  connectionSecretVersions,
  connectionEvents,
} from '../../schema/connections.js';
import { sealedFields } from '../records.queries.js';
import { appendAuditFact } from '../../governance/audit/events.repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';

import type { Pool } from 'pg';
import { z } from 'zod';
import {
  CONNECTION_EVENT_TYPE,
  CONNECTION_STATUS,
  ConnectionNotFoundError,
  ConnectionUnavailableError,
  parseRequestMetadata,
  providerKeySchema,
  selectConnection,
  uuidSchema,
  withConnectionTransaction,
  type RequestMetadata,
  type ResolvedConnectionSecretRecord,
} from '../records.queries.js';
import { requireConnectionUser } from '../authority.queries.js';

/**
 * Owns API credential resolution for ADR 046 read-only provider lookups and
 * its access audit fact. A lookup never changes connection health.
 */

export type ResolveConnectionLookupSecretInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    expectedProviderKey: string;
    purpose: string;
    signal?: AbortSignal;
  }>;

export type ConnectionLookupDatabase = Readonly<{
  resolveConnectionLookupSecret(
    input: ResolveConnectionLookupSecretInput,
  ): Promise<ResolvedConnectionSecretRecord>;
}>;

const lookupPurposeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u)
  .max(64);

export function createConnectionLookupPersistence(
  pool: Pool,
): ConnectionLookupDatabase {
  return Object.freeze({
    resolveConnectionLookupSecret: async (input) => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const expectedProviderKey = providerKeySchema.parse(
        input.expectedProviderKey,
      );
      const purpose = lookupPurposeSchema.parse(input.purpose);
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
