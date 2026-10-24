import { authDirectoryGroupMappings } from '../../../schema/identity/federation/directory/mappings.js';
import { authDirectoryGroupMembers } from '../../../schema/identity/federation/directory/members.js';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import type { DirectoryMapping, DirectoryRole } from './contract.js';

/** Mapping order is explicit: builder and operator are not a privilege ladder. */
export function directoryRole(
  mappings: readonly DirectoryMapping[],
  groups: ReadonlySet<string>,
  fallback: DirectoryRole,
): DirectoryRole {
  return (
    mappings.find((mapping) => groups.has(mapping.groupId))?.role ?? fallback
  );
}
export async function readDirectoryRole(
  client: PoolClient,
  organizationId: string,
  {
    workspaceId,
    directoryUserId,
    fallback,
  }: Readonly<{
    workspaceId: string;
    directoryUserId: string;
    fallback: DirectoryRole;
  }>,
): Promise<DirectoryRole> {
  const mappings = await drizzle(client)
    .select({
      groupId: authDirectoryGroupMappings.groupId,
      workspaceId: authDirectoryGroupMappings.workspaceId,
      role: authDirectoryGroupMappings.role,
      priority: authDirectoryGroupMappings.priority,
    })
    .from(authDirectoryGroupMappings)
    .where(
      and(
        eq(authDirectoryGroupMappings.organizationId, organizationId),
        eq(authDirectoryGroupMappings.workspaceId, workspaceId),
      ),
    )
    .orderBy(asc(authDirectoryGroupMappings.priority))
    .catch(rethrowQueryFailure);
  const memberships = await drizzle(client)
    .select({ group_id: authDirectoryGroupMembers.groupId })
    .from(authDirectoryGroupMembers)
    .where(
      and(
        eq(authDirectoryGroupMembers.organizationId, organizationId),
        eq(authDirectoryGroupMembers.directoryUserId, directoryUserId),
      ),
    )
    .catch(rethrowQueryFailure);
  const groups = new Set(memberships.map((row) => row.group_id));
  return directoryRole(mappings, groups, fallback);
}
