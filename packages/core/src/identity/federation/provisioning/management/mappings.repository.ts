import {
  users,
  workspaceMemberships,
  authDirectoryGroups,
  authDirectoryGroupMappings,
  authDirectoryMemberships,
} from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { ReplaceMappingsInput } from '../directory-provisioning.types.js';

export async function readDirectoryGroupIds(
  client: PoolClient,
  organizationId: string,
): Promise<string[]> {
  const groups = await drizzle(client)
    .select({ id: authDirectoryGroups.id })
    .from(authDirectoryGroups)
    .where(eq(authDirectoryGroups.organizationId, organizationId))
    .catch(rethrowQueryFailure);
  return groups.map((group) => group.id);
}

export async function replaceMappings(
  client: PoolClient,
  organizationId: string,
  mappings: ReplaceMappingsInput['mappings'],
): Promise<void> {
  await drizzle(client)
    .delete(authDirectoryGroupMappings)
    .where(eq(authDirectoryGroupMappings.organizationId, organizationId))
    .catch(rethrowQueryFailure);
  if (mappings.length > 0)
    await drizzle(client)
      .insert(authDirectoryGroupMappings)
      .values(
        mappings.map((mapping) => ({
          organizationId,
          workspaceId: mapping.workspaceId,
          groupId: mapping.groupId,
          role: mapping.role,
          priority: mapping.priority,
        })),
      )
      .catch(rethrowQueryFailure);
}

export async function lockUser(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await drizzle(client)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for('update')
    .catch(rethrowQueryFailure);
}

export async function lockMembership(
  client: PoolClient,
  workspaceId: string,
  userId: string,
) {
  const [member] = await drizzle(client)
    .select({
      role: workspaceMemberships.role,
      status: workspaceMemberships.status,
      role_revision: workspaceMemberships.roleRevision,
    })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return member;
}

export async function directoryManagesMembership(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const found = await drizzle(client)
    .select({ one: sql`1` })
    .from(authDirectoryMemberships)
    .where(
      and(
        eq(authDirectoryMemberships.workspaceId, workspaceId),
        eq(authDirectoryMemberships.userId, userId),
      ),
    )
    .catch(rethrowQueryFailure);
  return found.length !== 0;
}

export async function insertDirectoryMembership(
  client: PoolClient,
  membership: Readonly<{
    organizationId: string;
    workspaceId: string;
    userId: string;
    directoryUserId: string;
  }>,
): Promise<void> {
  await drizzle(client)
    .insert(authDirectoryMemberships)
    .values(membership)
    .catch(rethrowQueryFailure);
}
