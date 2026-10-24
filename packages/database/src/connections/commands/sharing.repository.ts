import type { Pool, PoolClient } from 'pg';

import type {
  ConnectionSharing,
  ConnectionSharingRequest,
} from '@pertexo/contracts';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.js';
import { claimCommand, completeCommand } from '../../platform/idempotency.js';
import { appendAuditFact } from '../../governance/audit/events.repository.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import type { ResourceActor } from '../../tenant-access/resources/contract.js';
import { requireConnectionManager } from '../authority.queries.js';
import {
  ConnectionNotFoundError,
  ConnectionSharingRevisionConflictError,
  connectionCommand,
  uuidSchema,
} from '../records.queries.js';

export type ConnectionSharingDatabase = Readonly<{
  readConnectionSharing(
    input: ResourceActor & { connectionId: string },
  ): Promise<ConnectionSharing>;
  replaceConnectionSharing(
    input: ResourceActor & {
      connectionId: string;
      request: ConnectionSharingRequest;
      idempotencyKey: string;
      requestId?: string;
      traceId?: string;
    },
  ): Promise<ConnectionSharing & { replayed: boolean }>;
}>;

async function readSharing(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionSharing> {
  const row = (
    await client.query<{
      access_mode: ConnectionSharing['mode'];
      sharing_revision: string;
    }>(
      'select access_mode,sharing_revision from app.connections where workspace_id=$1 and id=$2',
      [workspaceId, connectionId],
    )
  ).rows[0];
  if (row === undefined)
    throw new ConnectionNotFoundError('Connection is not visible');
  const members = (
    await client.query<{ userId: string; label: string; active: boolean }>(
      `select permission.user_id as "userId", person.display_name label,
      (membership.status='active' and person.status='active') active
    from app.connection_shares permission
    join app.workspace_memberships membership on membership.workspace_id=permission.workspace_id and membership.user_id=permission.user_id
    join app.users person on person.id=membership.user_id
    where permission.workspace_id=$1 and permission.connection_id=$2 order by permission.user_id limit 101`,
      [workspaceId, connectionId],
    )
  ).rows;
  if (members.length > 100)
    throw new Error('Connection shares exceed the supported bound');
  return {
    connectionId,
    mode: row.access_mode,
    revision: Number(row.sharing_revision),
    members,
  };
}

export function createConnectionSharingPersistence(
  pool: Pool,
): ConnectionSharingDatabase {
  return {
    readConnectionSharing: async (input) => {
      const actor = {
        workspaceId: uuidSchema.parse(input.workspaceId),
        actorId: uuidSchema.parse(input.actorId),
      };
      const connectionId = uuidSchema.parse(input.connectionId);
      return withTenantScopedClient(pool, actor, async (client) => {
        await requireConnectionManager(
          client,
          actor.workspaceId,
          actor.actorId,
        );
        return readSharing(client, actor.workspaceId, connectionId);
      });
    },
    replaceConnectionSharing: async (input) => {
      const actor = {
        workspaceId: uuidSchema.parse(input.workspaceId),
        actorId: uuidSchema.parse(input.actorId),
      };
      const connectionId = uuidSchema.parse(input.connectionId);
      const request = input.request;
      // Take the exclusive workspace fence first; upgrading a shared fence can deadlock concurrent edits.
      return withTenantScopedClient(pool, actor, async (client) => {
        await client.query(
          'select id from app.workspaces where id=$1 for update',
          [actor.workspaceId],
        );
        await requireConnectionManager(
          client,
          actor.workspaceId,
          actor.actorId,
        );
        const current = await readSharing(
          client,
          actor.workspaceId,
          connectionId,
        );
        const command = connectionCommand(
          {
            idempotencyKey: input.idempotencyKey,
            requestHash: canonicalOutboxPayloadChecksum(request),
          },
          actor.workspaceId,
          'connection.sharing',
          `${actor.actorId}:${connectionId}`,
        );
        const replay = await claimCommand<ConnectionSharing>(client, {
          ...command,
          resourceId: connectionId,
        });
        if (replay !== null)
          return {
            ...replay,
            replayed: true,
          };
        if (current.revision !== request.expectedSharingRevision)
          throw new ConnectionSharingRevisionConflictError();
        const members = await client.query(
          `select membership.user_id from app.workspace_memberships membership
          join app.users person on person.id=membership.user_id and person.status='active'
          where membership.workspace_id=$1 and membership.user_id=any($2::uuid[]) and membership.status='active'`,
          [actor.workspaceId, request.userIds],
        );
        if (members.rows.length !== request.userIds.length)
          throw new ConnectionNotFoundError('A sharing member is unavailable');
        await client.query(
          'delete from app.connection_shares where workspace_id=$1 and connection_id=$2',
          [actor.workspaceId, connectionId],
        );
        if (request.userIds.length > 0)
          await client.query(
            'insert into app.connection_shares(workspace_id,connection_id,user_id) select $1,$2,unnest($3::uuid[])',
            [actor.workspaceId, connectionId, request.userIds],
          );
        await client.query(
          'update app.connections set access_mode=$3,sharing_revision=sharing_revision+1 where workspace_id=$1 and id=$2',
          [actor.workspaceId, connectionId, request.mode],
        );
        const result = await readSharing(
          client,
          actor.workspaceId,
          connectionId,
        );
        await appendAuditFact(client, {
          workspaceId: actor.workspaceId,
          actorId: actor.actorId,
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
      });
    },
  };
}
