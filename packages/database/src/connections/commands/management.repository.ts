import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  connections,
  connectionSecretVersions,
  connectionEvents,
} from '../../schema/connections.js';
import { auditEvents } from '../../schema/foundation.js';
import { appendAuditFact } from '../../governance/audit/events.repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';

import type { Pool } from 'pg';
import { z } from 'zod';
import {
  uuidSchema,
  providerKeySchema,
  connectionNameSchema,
  sealedSecretSchema,
  connectionCommand,
  parseRequestMetadata,
  databaseConstraint,
  decodeDurableConnectionReplay,
  serializeConnectionSnapshot,
} from '../admission.js';
import {
  CONNECTION_STATUS,
  CONNECTION_AUTH_TYPE,
  ConnectionNotFoundError,
  ConnectionConflictError,
} from '../contract.js';
import { connectionFields, selectConnection } from '../records.queries.js';
import { withConnectionTransaction } from '../transactions.repository.js';
import { requireConnectionManager } from '../authority.queries.js';
import { revokeConnectionHealth } from '../health/transitions.repository.js';
import {
  claimCommand,
  completeCommand,
  findCommandResult,
} from '../../platform/idempotency.js';
import type { ConnectionDatabase } from '../contract.js';

/** Owns atomic creation/idempotency, reads, and revocation transactions. */

export type ConnectionManagementPersistence = Pick<
  ConnectionDatabase,
  | 'createConnection'
  | 'findConnectionCreateReplay'
  | 'getConnection'
  | 'revokeConnection'
>;

export function createConnectionManagementPersistence(
  pool: Pool,
): ConnectionManagementPersistence {
  return Object.freeze({
    createConnection: (input) => persistCreatedConnection(pool, input),

    findConnectionCreateReplay: (input) =>
      readConnectionCreateReplay(pool, input),

    getConnection: (workspaceId, connectionId) => {
      return withConnectionTransaction(pool, workspaceId, {
        actorId: undefined,
        operation: (client, parsedWorkspaceId) =>
          selectConnection(client, parsedWorkspaceId, connectionId),
      });
    },

    revokeConnection: (input) => persistRevokedConnection(pool, input),
  });
}

async function persistCreatedConnection(
  pool: Pool,
  input: Parameters<ConnectionManagementPersistence['createConnection']>[0],
): ReturnType<ConnectionManagementPersistence['createConnection']> {
  const connectionId = uuidSchema.parse(input.connectionId);
  const secretVersionId = uuidSchema.parse(input.secretVersionId);
  const actorId = uuidSchema.parse(input.actorId);
  const providerKey = providerKeySchema.parse(input.providerKey);
  const name = connectionNameSchema.parse(input.name);
  const authType = z.enum(CONNECTION_AUTH_TYPE).parse(input.authType);
  const sealed = sealedSecretSchema.parse(input.sealed);
  const metadata = parseRequestMetadata(input);
  try {
    return await withConnectionTransaction(pool, input.workspaceId, {
      actorId,
      operation: async (client, workspaceId) => {
        await requireConnectionManager(client, workspaceId, actorId);
        const command = connectionCommand(
          input,
          workspaceId,
          'connection.create',
          actorId,
        );
        const stored = await claimCommand(client, {
          ...command,
          resourceId: connectionId,
        });
        if (stored !== null) {
          const replay = decodeDurableConnectionReplay(stored);
          if (replay.workspaceId !== workspaceId)
            throw new Error('Connection idempotency result is corrupt');
          return replay;
        }
        const db = drizzle(client);
        const [row] = await db
          .insert(connections)
          .values({
            id: connectionId,
            workspaceId,
            providerKey,
            name,
            authType,
            status: 'active',
            currentSecretVersionId: secretVersionId,
            createdBy: actorId,
          })
          .returning(connectionFields)
          .catch(rethrowQueryFailure);
        if (row === undefined)
          throw new Error('Connection insert returned no row');
        const connection = Object.freeze(row);
        await db
          .insert(connectionSecretVersions)
          .values({
            id: secretVersionId,
            workspaceId,
            connectionId,
            kmsKeyReference: sealed.kmsKeyReference,
            encryptedDataKey: sealed.encryptedDataKey,
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
            authTag: sealed.tag,
            createdBy: actorId,
          })
          .catch(rethrowQueryFailure);
        await db
          .insert(connectionEvents)
          .values({
            id: generatePersistedId(),
            workspaceId,
            connectionId,
            eventType: 'connection.created',
            actorKind: 'user',
            actorId,
            requestId: metadata.requestId,
            traceId: metadata.traceId,
            metadata: { providerKey, authType, secretVersionId },
          })
          .catch(rethrowQueryFailure);
        await db
          .insert(auditEvents)
          .values({
            id: generatePersistedId(),
            workspaceId,
            actorUserId: actorId,
            action: 'connection.created',
            targetType: 'connection',
            targetId: connectionId,
            requestId: metadata.requestId,
            traceId: metadata.traceId,
            metadata: { providerKey, authType, secretVersionId },
          })
          .catch(rethrowQueryFailure);
        await completeCommand(
          client,
          command,
          serializeConnectionSnapshot(connection),
        );
        return connection;
      },
    }).catch(rethrowQueryFailure);
  } catch (error: unknown) {
    if (databaseConstraint(error, 'connections_active_name_provider_unique'))
      throw new ConnectionConflictError(
        'An active connection already uses this provider and name',
      );
    throw error;
  }
}

async function readConnectionCreateReplay(
  pool: Pool,
  input: Parameters<
    ConnectionManagementPersistence['findConnectionCreateReplay']
  >[0],
): ReturnType<ConnectionManagementPersistence['findConnectionCreateReplay']> {
  const actorId = uuidSchema.parse(input.actorId);
  return withConnectionTransaction(pool, input.workspaceId, {
    actorId,
    operation: async (client, workspaceId) => {
      await requireConnectionManager(client, workspaceId, actorId);
      const stored = await findCommandResult(
        client,
        connectionCommand(input, workspaceId, 'connection.create', actorId),
      );
      if (stored === null) return null;
      const replay = decodeDurableConnectionReplay(stored);
      if (replay.workspaceId !== workspaceId)
        throw new Error('Connection idempotency result is corrupt');
      return replay;
    },
  });
}

async function persistRevokedConnection(
  pool: Pool,
  input: Parameters<ConnectionManagementPersistence['revokeConnection']>[0],
): ReturnType<ConnectionManagementPersistence['revokeConnection']> {
  const actorId = uuidSchema.parse(input.actorId);
  const connectionId = uuidSchema.parse(input.connectionId);
  const metadata = parseRequestMetadata(input);
  return withConnectionTransaction(pool, input.workspaceId, {
    actorId,
    operation: async (client, workspaceId) => {
      await requireConnectionManager(client, workspaceId, actorId);
      const connection = await selectConnection(
        client,
        workspaceId,
        connectionId,
        { lock: true },
      );
      if (connection === null)
        throw new ConnectionNotFoundError('Connection is not visible');
      if (connection.status === CONNECTION_STATUS.revoked) return connection;
      const updated = await revokeConnectionHealth(
        client,
        workspaceId,
        connectionId,
      );
      await drizzle(client)
        .insert(connectionEvents)
        .values({
          id: generatePersistedId(),
          workspaceId,
          connectionId,
          eventType: 'connection.revoked',
          actorKind: 'user',
          actorId,
          requestId: metadata.requestId,
          traceId: metadata.traceId,
          metadata: {},
        })
        .catch(rethrowQueryFailure);
      await appendAuditFact(client, {
        workspaceId,
        actorId,
        action: 'connection.revoked',
        targetType: 'connection',
        targetId: connectionId,
        ...metadata,
        metadata: {},
      });
      const row = updated[0];
      if (row === undefined)
        throw new Error('Connection revocation returned no row');
      return Object.freeze(row);
    },
  });
}
