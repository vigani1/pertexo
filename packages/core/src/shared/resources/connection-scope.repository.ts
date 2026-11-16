import {
  and,
  eq,
  exists,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/pg-core';
import { connections, connectionShares } from '@pertexo/database/schema';
import type { PoolClient } from 'pg';
import { hasCapability, rolesForCapability, type Role } from '@pertexo/policy';
import { readWorkspaceAuthority } from '../access/workspace-authority.js';
import type { ResourceActor } from '../access/folder-access.types.js';
import { RESOURCE_ADMINISTRATORS } from '../access/folder-policy.js';

export type ConnectionCapability = 'connection:read' | 'connection:use';
export type ConnectionScope = Readonly<{
  workspaceId: string;
  actorId: string;
  workspaceShared: boolean;
  restricted: 'all' | 'matching' | 'none';
}>;

/** Role ceilings are decided here; SQL only matches the resulting resource facts. */
export function connectionScope(
  actor: ResourceActor,
  role: Role | null,
  capability: ConnectionCapability,
): ConnectionScope {
  const identity = { workspaceId: actor.workspaceId, actorId: actor.actorId };
  if (role === null || !hasCapability(role, capability))
    return Object.freeze({
      ...identity,
      workspaceShared: false,
      restricted: 'none',
    });
  const restricted = restrictedConnectionAudience(role);
  return Object.freeze({ ...identity, workspaceShared: true, restricted });
}

export async function readConnectionScope(
  client: PoolClient,
  actor: ResourceActor,
  capability: ConnectionCapability,
): Promise<ConnectionScope> {
  const role = await readWorkspaceAuthority(client, actor.workspaceId, {
    actorId: actor.actorId,
    roles: rolesForCapability(capability),
  });
  return connectionScope(actor, role ?? null, capability);
}

/** Filter discovery before paging, and admission before saving a new binding. */
export function connectionScopeSql(
  scope: ConnectionScope,
  connection: Readonly<{
    id: SQLWrapper;
    workspaceId: SQLWrapper;
    accessMode: SQLWrapper;
    createdBy: SQLWrapper;
  }> = alias(connections, 'connection'),
): SQL {
  if (!scope.workspaceShared) return sql`false`;
  const audience = connectionAudienceSql(scope, connection);
  return sql`${and(eq(connection.workspaceId, scope.workspaceId), audience)}`;
}

function restrictedConnectionAudience(
  role: Role,
): ConnectionScope['restricted'] {
  if (RESOURCE_ADMINISTRATORS.includes(role)) {
    return 'all';
  }
  if (hasCapability(role, 'connection:use')) {
    return 'matching';
  }
  return 'none';
}

function connectionAudienceSql(
  scope: ConnectionScope,
  connection: Readonly<{
    id: SQLWrapper;
    accessMode: SQLWrapper;
    createdBy: SQLWrapper;
  }>,
): SQL {
  if (scope.restricted === 'all') {
    return sql`true`;
  }
  if (scope.restricted === 'none') {
    return sql`${eq(connection.accessMode, 'workspace')}`;
  }
  const shared = new QueryBuilder()
    .select({ one: sql`1` })
    .from(connectionShares)
    .where(
      and(
        eq(connectionShares.workspaceId, scope.workspaceId),
        eq(connectionShares.connectionId, connection.id),
        eq(connectionShares.userId, scope.actorId),
      ),
    );
  return sql`${or(
    eq(connection.accessMode, 'workspace'),
    and(
      eq(connection.accessMode, 'restricted'),
      or(eq(connection.createdBy, scope.actorId), exists(shared)),
    ),
  )}`;
}
