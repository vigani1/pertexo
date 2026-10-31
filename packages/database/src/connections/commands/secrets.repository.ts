import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { appendAuditFact } from '../../governance/audit/events.repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import {
  connectionEvents,
  connections,
  connectionSecretVersions,
} from '../../schema/connections.js';
import { workspaces } from '../../schema/foundation.js';

import type { Pool } from 'pg';
import {
  claimCommand,
  completeCommand,
  findCommandResult,
} from '../../platform/idempotency/repository.js';
import {
  connectionCommand,
  decodeDurableConnectionReplay,
  parseRequestMetadata,
  serializeConnectionSnapshot,
} from '../admission.js';
import { requireConnectionManager } from '../authority.queries.js';
import type { ConnectionDatabase } from '../contract.js';
import {
  CONNECTION_AUTH_TYPE,
  CONNECTION_STATUS,
  ConnectionNotFoundError,
  ConnectionSecretVersionConflictError,
  ConnectionUnavailableError,
} from '../contract.js';
import { rotateConnectionHealth } from '../health/transitions.repository.js';
import {
  deleteOAuth2Grant,
  insertOAuth2Client,
  withOneOAuth2Fact,
} from '../oauth2/clients.repository.js';
import { selectConnection } from '../records.queries.js';
import { withConnectionTransaction } from '../transactions.repository.js';

/** Owns secret rotation idempotency and current-version fencing. */

export type ConnectionSecretPersistence = Pick<
  ConnectionDatabase,
  | 'findConnectionRotateReplay'
  | 'rotateConnectionSecret'
  | 'assertConnectionSecretCurrent'
>;

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
  const actorId = input.actorId;
  const connectionId = input.connectionId;
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
  const actorId = input.actorId;
  const connectionId = input.connectionId;
  const secretVersionId = input.secretVersionId;
  const expected = input.expectedCurrentSecretVersionId;
  const sealed = input.sealed;
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
      if (input.expectedAuthType === CONNECTION_AUTH_TYPE.oauth2) {
        await insertOAuth2Client(client, {
          workspaceId,
          connectionId,
          secretVersionId,
          settings: input.oauth2Settings,
        });
        await deleteOAuth2Grant(client, workspaceId, connectionId);
      }
      const updated = await rotateConnectionHealth(
        client,
        workspaceId,
        connectionId,
        {
          secretVersionId,
          ...(input.expectedAuthType === CONNECTION_AUTH_TYPE.oauth2
            ? {
                status: CONNECTION_STATUS.reauthorizationRequired,
                lastErrorCode: 'connection.oauth2_not_authorized',
              }
            : { status: CONNECTION_STATUS.active, lastErrorCode: null }),
        },
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
      const rotated = await withOneOAuth2Fact(
        client,
        workspaceId,
        Object.freeze(row),
      );
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
  const connectionId = input.connectionId;
  const expectedProviderKey = input.expectedProviderKey;
  const expectedAuthType = input.expectedAuthType;
  const secretVersionId = input.secretVersionId;
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
