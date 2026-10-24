import { rethrowQueryFailure } from '../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { rolesForCapability, type Role } from '@pertexo/workflow-model';
import { lockWorkspaceAuthority } from '../tenant-access/workspaces/authority.js';
import { WorkspaceAccessDeniedError } from '../tenant-access/errors.js';
import {
  connectionScope,
  connectionScopeSql,
} from '../tenant-access/resources/connections/scope.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { connections } from '../schema/connections.js';
import { ConnectionNotFoundError } from './contract.js';

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
  const found = await drizzle(client)
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, connectionId),
        connectionScopeSql(
          connectionScope({ workspaceId, actorId }, role, 'connection:use'),
          sql`${connections}`,
        ),
      ),
    )
    .catch(rethrowQueryFailure);
  if (found.length !== 1)
    throw new ConnectionNotFoundError('Connection is not visible');
}
