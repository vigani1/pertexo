import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  connections,
  connectionSecretVersions,
  connectionEvents,
} from '../../schema/connections.js';
import { workspaces } from '../../schema/foundation.js';
import { appendAuditFact } from '../../governance/audit/events.repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';

import type { Pool } from 'pg';
import { z } from 'zod';
import {
  uuidSchema,
  providerKeySchema,
  sealedSecretSchema,
  connectionCommand,
  parseRequestMetadata,
  decodeDurableConnectionReplay,
  serializeConnectionSnapshot,
} from '../admission.js';
import {
  CONNECTION_STATUS,
  CONNECTION_AUTH_TYPE,
  ConnectionNotFoundError,
  ConnectionUnavailableError,
  ConnectionSecretVersionConflictError,
} from '../contract.js';
import { withConnectionTransaction } from '../transactions.repository.js';
import { selectConnection } from '../records.queries.js';
import { requireConnectionManager } from '../authority.queries.js';
import { rotateConnectionHealth } from '../health/transitions.repository.js';
import {claimCommand, completeCommand, findCommandResult} from '../../platform/idempotency/repository.js';
import type { ConnectionDatabase } from '../contract.js';

/** Owns secret rotation idempotency and current-version fencing. */

export type ConnectionSecretPersistence = Pick<
  ConnectionDatabase,
  | 'findConnectionRotateReplay'
  | 'rotateConnectionSecret'
  | 'assertConnectionSecretCurrent'
>;

function parseConnectionAuthType(input: unknown) {
  return z.enum(CONNECTION_AUTH_TYPE).parse(input);
}

export function createConnectionSecretPersistence(
  pool: Pool,
): ConnectionSecretPersistence {
  return Object.freeze({
    findConnectionRotateReplay: (input) =>
      readConnectionRotateReplay(pool, input),
    rotateConnectionSecret: (input) =>
      persistRotatedConnectionSecret(pool, input),
    assertConnectionSecretCurrent: (input) =>
      assertPersistedConnectionSecretCurrent(pool, input),
  });
}

async function readConnectionRotateReplay(
  pool: Pool,
  input: Parameters<
    ConnectionSecretPersistence['findConnectionRotateReplay']
  >[0],
): ReturnType<ConnectionSecretPersistence['findConnectionRotateReplay']> {
  const actorId = uuidSchema.parse(input.actorId);
  const connectionId = uuidSchema.parse(input.connectionId);
  return withConnectionTransaction(pool, input.workspaceId, {
    actorId,
    operation: async (client, workspaceId) => {
      await requireConnectionManager(client, workspaceId, actorId);
      const stored = await findCommandResult(
        client,
        connectionCommand(
          input,
          workspaceId,
          'connection.secret.rotate',
          `${actorId}:${connectionId}`,
        ),
      );
      if (stored === null) return null;
      const replay = decodeDurableConnectionReplay(stored);
      if (replay.id !== connectionId || replay.workspaceId !== workspaceId)
        throw new Error('Connection rotation idempotency result is corrupt');
      return replay;
    },
  });
}

async function persistRotatedConnectionSecret(
  pool: Pool,
  input: Parameters<ConnectionSecretPersistence['rotateConnectionSecret']>[0],
): ReturnType<ConnectionSecretPersistence['rotateConnectionSecret']> {
  const actorId = uuidSchema.parse(input.actorId);
  const connectionId = uuidSchema.parse(input.connectionId);
  const secretVersionId = uuidSchema.parse(input.secretVersionId);
  const expected = uuidSchema.parse(input.expectedCurrentSecretVersionId);
  const sealed = sealedSecretSchema.parse(input.sealed);
  const metadata = parseRequestMetadata(input);
  return withConnectionTransaction(pool, input.workspaceId, {
    actorId,
    operation: async (client, workspaceId) => {
      await requireConnectionManager(client, workspaceId, actorId);
      const command = connectionCommand(
        input,
        workspaceId,
        'connection.secret.rotate',
        `${actorId}:${connectionId}`,
      );
      const stored = await claimCommand(client, {
        ...command,
        resourceId: connectionId,
      });
      if (stored !== null) {
        const replay = decodeDurableConnectionReplay(stored);
        if (replay.id !== connectionId || replay.workspaceId !== workspaceId)
          throw new Error('Connection rotation idempotency result is corrupt');
        return replay;
      }
      const connection = await selectConnection(
        client,
        workspaceId,
        connectionId,
        { lock: true },
      );
      if (connection === null)
        throw new ConnectionNotFoundError('Connection is not visible');
      if (connection.status === CONNECTION_STATUS.revoked)
        throw new ConnectionUnavailableError('Connection is revoked');
      if (
        connection.authType !==
        (input.expectedAuthType ?? CONNECTION_AUTH_TYPE.httpHeaders)
      )
        throw new ConnectionUnavailableError(
          'Connection authentication type cannot be changed by rotation',
        );
      if (connection.currentSecretVersionId !== expected)
        throw new ConnectionSecretVersionConflictError(
          'Connection secret version does not match',
        );
      await drizzle(client)
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
      const updated = await rotateConnectionHealth(
        client,
        workspaceId,
        connectionId,
        secretVersionId,
      );
      await drizzle(client)
        .insert(connectionEvents)
        .values({
          id: generatePersistedId(),
          workspaceId,
          connectionId,
          eventType: 'connection.secret_rotated',
          actorKind: 'user',
          actorId,
          requestId: metadata.requestId,
          traceId: metadata.traceId,
          metadata: { previousSecretVersionId: expected, secretVersionId },
        })
        .catch(rethrowQueryFailure);
      await appendAuditFact(client, {
        workspaceId,
        actorId,
        action: 'connection.secret_rotated',
        targetType: 'connection',
        targetId: connectionId,
        ...metadata,
        metadata: { previousSecretVersionId: expected, secretVersionId },
      });
      const row = updated[0];
      if (row === undefined)
        throw new Error('Connection rotation returned no row');
      const rotated = Object.freeze(row);
      await completeCommand(
        client,
        command,
        serializeConnectionSnapshot(rotated),
      );
      return rotated;
    },
  });
}

async function assertPersistedConnectionSecretCurrent(
  pool: Pool,
  input: Parameters<
    ConnectionSecretPersistence['assertConnectionSecretCurrent']
  >[0],
): ReturnType<ConnectionSecretPersistence['assertConnectionSecretCurrent']> {
  const connectionId = uuidSchema.parse(input.connectionId);
  const expectedProviderKey = providerKeySchema.parse(
    input.expectedProviderKey,
  );
  const expectedAuthType = parseConnectionAuthType(input.expectedAuthType);
  const secretVersionId = uuidSchema.parse(input.secretVersionId);
  await withConnectionTransaction(pool, input.workspaceId, {
    actorId: undefined,
    operation: async (client, workspaceId) => {
      const result = await drizzle(client)
        .select({ id: connections.id })
        .from(connections)
        .innerJoin(workspaces, eq(workspaces.id, connections.workspaceId))
        .where(
          and(
            eq(connections.workspaceId, workspaceId),
            eq(connections.id, connectionId),
            eq(connections.providerKey, expectedProviderKey),
            eq(connections.authType, expectedAuthType),
            eq(connections.currentSecretVersionId, secretVersionId),
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
    options: input.signal === undefined ? {} : { signal: input.signal },
  }).catch(rethrowQueryFailure);
}
