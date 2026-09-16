import type { PoolClient } from 'pg';

import { rolesForCapability } from '../tenant-access/workspace-policy.js';
import {
  ConnectionNotFoundError,
  uuidSchema,
} from './connection-persistence.js';

async function requireConnectionCapability(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  capability: 'connection:manage' | 'connection:read' | 'connection:use',
): Promise<void> {
  const result = await client.query(
    `select 1 from app.workspace_memberships membership
     join app.workspaces workspace on workspace.id = membership.workspace_id
     join app.users actor on actor.id = membership.user_id
     where membership.workspace_id = $1 and membership.user_id = $2
       and membership.status = 'active'
       and membership.role = any($3::text[])
       and workspace.status = 'active' and actor.status = 'active'
     for share of membership, workspace, actor`,
    [
      workspaceId,
      uuidSchema.parse(actorId),
      [...rolesForCapability(capability)],
    ],
  );
  if (result.rowCount !== 1)
    throw new ConnectionNotFoundError('Connection is not visible');
}

export function requireConnectionManager(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<void> {
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
): Promise<void> {
  return requireConnectionCapability(
    client,
    workspaceId,
    actorId,
    'connection:read',
  );
}

export function requireConnectionUser(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  return requireConnectionCapability(
    client,
    workspaceId,
    actorId,
    'connection:use',
  );
}
