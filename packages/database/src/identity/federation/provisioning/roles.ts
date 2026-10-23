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
  const mappings = (
    await client.query<DirectoryMapping>(
      'select group_id "groupId",workspace_id "workspaceId",role,priority from app.auth_directory_group_mappings where organization_id=$1 and workspace_id=$2 order by priority',
      [organizationId, workspaceId],
    )
  ).rows;
  const groups = new Set(
    (
      await client.query<{ group_id: string }>(
        'select group_id from app.auth_directory_group_members where organization_id=$1 and directory_user_id=$2',
        [organizationId, directoryUserId],
      )
    ).rows.map((row) => row.group_id),
  );
  return directoryRole(mappings, groups, fallback);
}
