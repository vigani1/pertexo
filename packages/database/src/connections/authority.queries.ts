import type { PoolClient } from 'pg';
import { rolesForCapability, type Role } from '@pertexo/workflow-model';
import { lockWorkspaceAuthority } from '../tenant-access/workspaces/authority.js';
import { WorkspaceAccessDeniedError } from '../tenant-access/errors.js';
import {
  connectionScope,
  connectionScopeSql,
} from '../tenant-access/resources/connections/scope.js';
import { bindResourcePredicate } from '../tenant-access/resources/query-scope.js';
import { ConnectionNotFoundError } from './records.queries.js';

async function requireConnectionCapability(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  capability: 'connection:manage' | 'connection:read' | 'connection:use',
): Promise<Role> {
  try {
    return await lockWorkspaceAuthority(
      client,
      workspaceId,
      actorId,
      rolesForCapability(capability),
    );
  } catch (error) {
    if (error instanceof WorkspaceAccessDeniedError)
      throw new ConnectionNotFoundError('Connection is not visible');
    throw error;
  }
}
export function requireConnectionManager(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<Role> {
  return requireConnectionCapability(
    client,
    workspaceId,
    actorId,
    'connection:manage',
  );
}
export function requireConnectionReader(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<Role> {
  return requireConnectionCapability(
    client,
    workspaceId,
    actorId,
    'connection:read',
  );
}
export async function requireConnectionUser(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  connectionId: string,
): Promise<void> {
  const role = await requireConnectionCapability(
    client,
    workspaceId,
    actorId,
    'connection:use',
  );
  const parameters: unknown[] = [workspaceId, connectionId];
  const permitted = bindResourcePredicate(
    connectionScopeSql(
      connectionScope({ workspaceId, actorId }, role, 'connection:use'),
    ),
    parameters,
  );
  const found = await client.query(
    `select 1 from app.connections connection where connection.workspace_id=$1 and connection.id=$2 and ${permitted}`,
    parameters,
  );
  if (found.rowCount !== 1)
    throw new ConnectionNotFoundError('Connection is not visible');
}
