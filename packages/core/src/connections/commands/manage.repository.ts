import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import {
  isUniqueConstraintFailure,
  postgresFailure,
  rethrowQueryFailure,
  claimCommand,
  completeCommand,
  findCommandResult,
} from '@pertexo/database/primitives';
import { connections } from '@pertexo/database/schema';

import type {
  ConnectionRecord,
  CreateConnectionInput,
  FindConnectionCreateReplayInput,
  RevokeConnectionInput,
} from '../contract.js';
import {
  CONNECTION_AUTH_TYPE,
  CONNECTION_EVENT_TYPE,
  CONNECTION_STATUS,
  ConnectionConflictError,
  ConnectionNotFoundError,
} from '../contract.js';
import { recordMemberAction } from '../events.repository.js';
import { healthOfNewSecret } from '../health/rules.js';
import { revokeConnectionHealth } from '../health/transitions.repository.js';
import {
  deleteOAuth2Grant,
  insertOAuth2Client,
  withOneOAuth2Fact,
} from '../oauth2/clients.repository.js';
import {
  connectionCommand,
  decodeDurableConnectionReplay,
  serializeConnectionSnapshot,
} from '../receipts.js';
import { connectionFields, selectConnection } from '../records.queries.js';
import { insertSecretVersion } from './secret-version.repository.js';

const CREATE_OPERATION = 'connection.create';

export async function createConnection(
  client: PoolClient,
  input: CreateConnectionInput,
): Promise<ConnectionRecord> {
  const { workspaceId, actorId, connectionId, secretVersionId } = input;
  const { providerKey, name, authType, sealed } = input;
  const command = connectionCommand(
    input,
    workspaceId,
    CREATE_OPERATION,
    actorId,
  );
  const stored = await claimCommand(client, {
    ...command,
    resourceId: connectionId,
  });
  if (stored !== null) return decodeCreateReplay(stored, workspaceId);
  const [row] = await drizzle(client)
    .insert(connections)
    .values({
      id: connectionId,
      workspaceId,
      providerKey,
      name,
      authType,
      ...healthOfNewSecret(authType),
      currentSecretVersionId: secretVersionId,
      createdBy: actorId,
    })
    .returning(connectionFields)
    .catch(refuseDuplicateName);
  if (row === undefined) throw new Error('Connection insert returned no row');
  await insertSecretVersion(client, {
    workspaceId,
    connectionId,
    secretVersionId,
    sealed,
    createdBy: actorId,
  });
  if (input.authType === CONNECTION_AUTH_TYPE.oauth2)
    await insertOAuth2Client(client, {
      workspaceId,
      connectionId,
      secretVersionId,
      settings: input.oauth2Settings,
    });
  const connection = await withOneOAuth2Fact(
    client,
    workspaceId,
    Object.freeze(row),
  );
  await recordMemberAction(client, {
    workspaceId,
    connectionId,
    eventType: CONNECTION_EVENT_TYPE.created,
    actorId,
    requestId: input.requestId,
    traceId: input.traceId,
    metadata: { providerKey, authType, secretVersionId },
  });
  await completeCommand(
    client,
    command,
    serializeConnectionSnapshot(connection),
  );
  return connection;
}

export async function findConnectionCreateReplay(
  client: PoolClient,
  input: FindConnectionCreateReplayInput,
): Promise<ConnectionRecord | null> {
  const stored = await findCommandResult(
    client,
    connectionCommand(
      input,
      input.workspaceId,
      CREATE_OPERATION,
      input.actorId,
    ),
  );
  return stored === null ? null : decodeCreateReplay(stored, input.workspaceId);
}

export async function revokeConnection(
  client: PoolClient,
  input: RevokeConnectionInput,
): Promise<ConnectionRecord> {
  const { workspaceId, actorId, connectionId } = input;
  const connection = await selectConnection(client, workspaceId, connectionId, {
    lock: true,
  });
  if (connection === null)
    throw new ConnectionNotFoundError('Connection is not visible');
  if (connection.status === CONNECTION_STATUS.revoked)
    return withOneOAuth2Fact(client, workspaceId, connection);
  const updated = await revokeConnectionHealth(
    client,
    workspaceId,
    connectionId,
  );
  if (connection.authType === CONNECTION_AUTH_TYPE.oauth2)
    await deleteOAuth2Grant(client, workspaceId, connectionId);
  await recordMemberAction(client, {
    workspaceId,
    connectionId,
    eventType: CONNECTION_EVENT_TYPE.revoked,
    actorId,
    requestId: input.requestId,
    traceId: input.traceId,
    metadata: {},
  });
  const row = updated[0];
  if (row === undefined)
    throw new Error('Connection revocation returned no row');
  return withOneOAuth2Fact(client, workspaceId, Object.freeze(row));
}

function decodeCreateReplay(
  stored: unknown,
  workspaceId: string,
): ConnectionRecord {
  const replay = decodeDurableConnectionReplay(stored);
  if (replay.workspaceId !== workspaceId)
    throw new Error('Connection idempotency result is corrupt');
  return replay;
}

function refuseDuplicateName(error: unknown): never {
  if (
    isUniqueConstraintFailure(error) &&
    postgresFailure(error).constraint ===
      'connections_active_name_provider_unique'
  )
    throw new ConnectionConflictError(
      'An active connection already uses this provider and name',
    );
  return rethrowQueryFailure(error);
}
