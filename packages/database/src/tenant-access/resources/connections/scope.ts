import { sql, type SQL } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import {
  hasCapability,
  rolesForCapability,
  type Role,
} from '@pertexo/workflow-model';
import { WorkspaceAccessDeniedError } from '../../errors.js';
import { readWorkspaceAuthority } from '../../workspaces/authority.queries.js';
import type { ResourceActor } from '../contract.js';
import { RESOURCE_ADMINISTRATORS } from '../policy.js';

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
  let role: Role | null = null;
  try {
    role = await readWorkspaceAuthority(client, actor.workspaceId, {
      actorId: actor.actorId,
      roles: rolesForCapability(capability),
    });
  } catch (error) {
    if (!(error instanceof WorkspaceAccessDeniedError)) throw error;
  }
  return connectionScope(actor, role, capability);
}

/** Filter discovery before paging, and admission before saving a new binding. */
export function connectionScopeSql(
  scope: ConnectionScope,
  connection: SQL = sql`connection`,
): SQL {
  if (!scope.workspaceShared) return sql`false`;
  const audience = connectionAudienceSql(scope, connection);
  return sql`(${connection}.workspace_id=${scope.workspaceId} and ${audience})`;
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

function connectionAudienceSql(scope: ConnectionScope, connection: SQL): SQL {
  if (scope.restricted === 'all') {
    return sql`true`;
  }
  if (scope.restricted === 'none') {
    return sql`${connection}.access_mode='workspace'`;
  }
  return sql`(${connection}.access_mode='workspace' or
      (${connection}.access_mode='restricted' and (${connection}.created_by=${scope.actorId} or exists (
        select 1 from app.connection_shares permission
        where permission.workspace_id=${scope.workspaceId} and permission.connection_id=${connection}.id
          and permission.user_id=${scope.actorId}))))`;
}
