import type { ConnectionSharingDatabase } from './contract.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { connections, connectionShares } from '../../schema/connections.js';
import {
  workspaces,
  workspaceMemberships,
  users,
} from '../../schema/foundation.js';
import type { Pool, PoolClient } from 'pg';

import type { ConnectionSharing } from '@pertexo/contracts';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';
import { claimCommand, completeCommand } from '../../platform/idempotency.js';
import { appendAuditFact } from '../../governance/audit/events.repository.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';

import { requireConnectionManager } from '../authority.queries.js';
import {
  ConnectionNotFoundError,
  ConnectionSharingRevisionConflictError,
} from '../contract.js';
import { connectionCommand, uuidSchema } from '../admission.js';

async function readSharing(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionSharing> {
  const db = drizzle(client);
  const [row] = await db
    .select({
      accessMode: connections.accessMode,
      sharingRevision: connections.sharingRevision,
    })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, connectionId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new ConnectionNotFoundError('Connection is not visible');
  const members = await db
    .select({
      userId: connectionShares.userId,
      label: users.displayName,
      active: sql<boolean>`(${workspaceMemberships.status}='active' and ${users.status}='active')`,
    })
    .from(connectionShares)
    .innerJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, connectionShares.workspaceId),
        eq(workspaceMemberships.userId, connectionShares.userId),
      ),
    )
    .innerJoin(users, eq(users.id, workspaceMemberships.userId))
    .where(
      and(
        eq(connectionShares.workspaceId, workspaceId),
        eq(connectionShares.connectionId, connectionId),
      ),
    )
    .orderBy(connectionShares.userId)
    .limit(101)
    .catch(rethrowQueryFailure);
  if (members.length > 100)
    throw new Error('Connection shares exceed the supported bound');
  return {
    connectionId,
    mode: row.accessMode,
    revision: row.sharingRevision,
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
        const db = drizzle(client);
        await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, actor.workspaceId))
          .for('update')
          .catch(rethrowQueryFailure);
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
        const members = await db
          .select({ userId: workspaceMemberships.userId })
          .from(workspaceMemberships)
          .innerJoin(
            users,
            and(
              eq(users.id, workspaceMemberships.userId),
              eq(users.status, 'active'),
            ),
          )
          .where(
            and(
              eq(workspaceMemberships.workspaceId, actor.workspaceId),
              inArray(workspaceMemberships.userId, [...request.userIds]),
              eq(workspaceMemberships.status, 'active'),
            ),
          )
          .catch(rethrowQueryFailure);
        if (members.length !== request.userIds.length)
          throw new ConnectionNotFoundError('A sharing member is unavailable');
        const predicate = and(
          eq(connectionShares.workspaceId, actor.workspaceId),
          eq(connectionShares.connectionId, connectionId),
        );
        await db
          .delete(connectionShares)
          .where(predicate)
          .catch(rethrowQueryFailure);
        if (request.userIds.length > 0)
          await db
            .insert(connectionShares)
            .values(
              request.userIds.map((userId) => ({
                workspaceId: actor.workspaceId,
                connectionId,
                userId,
              })),
            )
            .catch(rethrowQueryFailure);
        await db
          .update(connections)
          .set({
            accessMode: request.mode,
            sharingRevision: sql`${connections.sharingRevision}+1`,
          })
          .where(
            and(
              eq(connections.workspaceId, actor.workspaceId),
              eq(connections.id, connectionId),
            ),
          )
          .catch(rethrowQueryFailure);
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
