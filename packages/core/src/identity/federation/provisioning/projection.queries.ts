import {
  authDirectoryUsers,
  authDirectoryGroupMappings,
  authDirectoryGroupMembers,
  workspaces,
  workspaceMemberships,
  authDirectoryMemberships,
  users as globalUsers,
} from '@pertexo/database/schema';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

import type { PoolClient } from 'pg';

export async function loadDirectoryProjection(
  client: PoolClient,
  organizationId: string,
  directoryUserIds?: readonly string[],
) {
  const db = drizzle(client);
  // The query excludes unbound directory rows before these IDs enter fan-out writes.
  const users = await db
    .select({
      id: authDirectoryUsers.id,
      user_id: sql<string>`${authDirectoryUsers.userId}`,
      active: authDirectoryUsers.active,
      deleted_at: authDirectoryUsers.deletedAt,
    })
    .from(authDirectoryUsers)
    .where(
      and(
        eq(authDirectoryUsers.organizationId, organizationId),
        isNotNull(authDirectoryUsers.userId),
        directoryUserIds === undefined
          ? undefined
          : inArray(authDirectoryUsers.id, directoryUserIds),
      ),
    )
    .orderBy(asc(authDirectoryUsers.userId))
    .catch(rethrowQueryFailure);
  if (users.length === 0) return undefined;
  const userIds = users.map((user) => user.user_id);
  await db
    .select({ id: globalUsers.id })
    .from(globalUsers)
    .where(inArray(globalUsers.id, userIds))
    .orderBy(asc(globalUsers.id))
    .for('update')
    .catch(rethrowQueryFailure);
  const groupRoles = await db
    .select({
      workspaceId: authDirectoryGroupMappings.workspaceId,
      groupId: authDirectoryGroupMappings.groupId,
      role: authDirectoryGroupMappings.role,
      priority: authDirectoryGroupMappings.priority,
    })
    .from(authDirectoryGroupMappings)
    .where(eq(authDirectoryGroupMappings.organizationId, organizationId))
    .orderBy(
      asc(authDirectoryGroupMappings.workspaceId),
      asc(authDirectoryGroupMappings.priority),
    )
    .catch(rethrowQueryFailure);
  const groupMembers = await db
    .select({
      group_id: authDirectoryGroupMembers.groupId,
      directory_user_id: authDirectoryGroupMembers.directoryUserId,
    })
    .from(authDirectoryGroupMembers)
    .where(
      and(
        eq(authDirectoryGroupMembers.organizationId, organizationId),
        inArray(
          authDirectoryGroupMembers.directoryUserId,
          users.map((user) => user.id),
        ),
      ),
    )
    .catch(rethrowQueryFailure);
  const groupsByUser = new Map<string, Set<string>>();
  for (const member of groupMembers) {
    const groups =
      groupsByUser.get(member.directory_user_id) ?? new Set<string>();
    groups.add(member.group_id);
    groupsByUser.set(member.directory_user_id, groups);
  }
  return { users, userIds, groupRoles, groupsByUser };
}
export async function loadWorkspaceProjection(
  client: PoolClient,
  {
    workspaceId,
    userIds,
  }: Readonly<{ workspaceId: string; userIds: readonly string[] }>,
) {
  const [workspaceState] = await drizzle(client)
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .catch(rethrowQueryFailure);
  const active = workspaceState?.status === 'active';
  const member = alias(workspaceMemberships, 'member');
  const records = await drizzle(client)
    .select({
      user_id: member.userId,
      role: member.role,
      status: member.status,
      role_revision: member.roleRevision,
      directory_user_id: authDirectoryMemberships.directoryUserId,
    })
    .from(member)
    .leftJoin(
      authDirectoryMemberships,
      and(
        eq(authDirectoryMemberships.workspaceId, member.workspaceId),
        eq(authDirectoryMemberships.userId, member.userId),
      ),
    )
    .where(
      and(eq(member.workspaceId, workspaceId), inArray(member.userId, userIds)),
    )
    .orderBy(asc(member.userId))
    .for('update', { of: member })
    .catch(rethrowQueryFailure);
  const members = new Map(records.map((member) => [member.user_id, member]));
  return { active, members };
}
