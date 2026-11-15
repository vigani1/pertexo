import type { PoolClient } from 'pg';
import {
  canonicalOutboxPayloadChecksum,
  claimCommand,
  completeCommand,
} from '@pertexo/database/primitives';
import { appendAuditFact } from '../../governance/audit/facts.js';
import type {
  ReadConnectionSharingInput,
  ReplaceConnectionSharingInput,
} from './connection-sharing.types.js';

import { CONNECTION_SHARE_LIMIT } from '@pertexo/workflow-model';
import type { ConnectionSharing } from '@pertexo/contracts';

import {
  ConnectionNotFoundError,
  ConnectionSharingCorruptError,
  ConnectionSharingRevisionConflictError,
} from '../connection.errors.js';
import { connectionCommand, connectionCommandScope } from '../receipts.js';
import {
  countActiveMembers,
  readShareMembers,
  readSharingMode,
  replaceShares,
} from './sharing.repository.js';

async function readSharing(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionSharing> {
  const row = await readSharingMode(client, { workspaceId, connectionId });
  if (row === undefined)
    throw new ConnectionNotFoundError('Connection is not visible');
  const members = await readShareMembers(client, { workspaceId, connectionId });
  if (members.length > CONNECTION_SHARE_LIMIT)
    throw new ConnectionSharingCorruptError();
  return {
    connectionId,
    mode: row.accessMode,
    revision: row.sharingRevision,
    members,
  };
}

export function readConnectionSharing(
  client: PoolClient,
  input: ReadConnectionSharingInput,
): Promise<ConnectionSharing> {
  return readSharing(client, input.workspaceId, input.connectionId);
}

export async function replaceConnectionSharing(
  client: PoolClient,
  input: ReplaceConnectionSharingInput,
): Promise<ConnectionSharing & { replayed: boolean }> {
  const { workspaceId, actorId, connectionId, request } = input;
  const current = await readSharing(client, workspaceId, connectionId);
  const command = connectionCommand(
    {
      idempotencyKey: input.idempotencyKey,
      requestHash: canonicalOutboxPayloadChecksum(request),
    },
    workspaceId,
    'connection.sharing',
    connectionCommandScope(actorId, connectionId),
  );
  const replay = await claimCommand<ConnectionSharing>(client, {
    ...command,
    resourceId: connectionId,
  });
  if (replay !== null) return { ...replay, replayed: true };
  if (current.revision !== request.expectedSharingRevision)
    throw new ConnectionSharingRevisionConflictError();
  const activeMembers = await countActiveMembers(
    client,
    workspaceId,
    request.userIds,
  );
  if (activeMembers !== request.userIds.length)
    throw new ConnectionNotFoundError('A sharing member is unavailable');
  await replaceShares(client, { workspaceId, connectionId }, request);
  const result = await readSharing(client, workspaceId, connectionId);
  await appendAuditFact(client, {
    workspaceId,
    actorId,
    action: 'connection.sharing_changed',
    targetType: 'connection',
    targetId: connectionId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata: {
      mode: request.mode,
      revision: result.revision,
      members: request.userIds.length,
      previousShares: canonicalOutboxPayloadChecksum(
        current.members.map((member) => member.userId),
      ),
      shares: canonicalOutboxPayloadChecksum([...request.userIds].sort()),
    },
  });
  await completeCommand(client, command, result);
  return { ...result, replayed: false };
}
