import type { PoolClient } from 'pg';
import type {
  DirectorySettings,
  DirectoryPeopleQuery,
} from '@pertexo/contracts';
import type { DirectoryOrganization } from '../authority.repository.js';
import { publicCredential, type CredentialRow } from './credentials.repository.js';
import type { DirectoryMapping } from '../contract.js';

export async function projectDirectorySettings(
  client: PoolClient,
  organization: DirectoryOrganization,
  { canManage }: Readonly<{ canManage: boolean }>,
): Promise<DirectorySettings> {
  const counts = (
    await client.query<{ users: number; activeUsers: number; groups: number }>(
      `select count(*)::integer users,count(*) filter(where active and deleted_at is null)::integer "activeUsers",
      (select count(*)::integer from app.auth_directory_groups where organization_id=$1) groups from app.auth_directory_users where organization_id=$1`,
      [organization.id],
    )
  ).rows[0];
  if (counts === undefined) throw new Error('Directory counts returned no row');
  const credentials = (
    await client.query<CredentialRow>(
      'select id,name,created_at,revoked_at,last_used_at from app.auth_provisioning_credentials where organization_id=$1 order by (revoked_at is null) desc,created_at desc,id desc limit 50',
      [organization.id],
    )
  ).rows;
  const groups = (
    await client.query<{
      id: string;
      displayName: string;
      memberCount: number;
    }>(
      `select directory.id,directory.display_name "displayName",count(member.directory_user_id)::integer "memberCount" from app.auth_directory_groups directory
     left join app.auth_directory_group_members member on member.organization_id=directory.organization_id and member.group_id=directory.id
     where directory.organization_id=$1 group by directory.id order by directory.display_name,directory.id`,
      [organization.id],
    )
  ).rows;
  const mappings = (
    await client.query<DirectoryMapping>(
      'select group_id "groupId",workspace_id "workspaceId",role,priority from app.auth_directory_group_mappings where organization_id=$1 order by workspace_id,priority',
      [organization.id],
    )
  ).rows;
  return {
    canManage,
    organizationId: organization.id,
    controlWorkspaceId: organization.control_workspace_id,
    revision: organization.revision,
    counts,
    credentials: credentials.map(publicCredential),
    groups,
    mappings,
  };
}
export async function listDirectoryPeople(
  client: PoolClient,
  organizationId: string,
  query: DirectoryPeopleQuery,
) {
  const rows = (
    await client.query<{
      id: string;
      userName: string;
      email: string;
      active: boolean;
      boundUserId: string | null;
      revision: number;
      deleted: boolean;
    }>(
      `select id,user_name "userName",login_email email,active,user_id "boundUserId",revision,(deleted_at is not null) deleted
     from app.auth_directory_users where organization_id=$1 and ($2::uuid is null or id>$2)
     and ($3::text is null or strpos(lower(user_name),lower($3))>0 or strpos(login_email,lower($3))>0)
     order by id limit $4`,
      [
        organizationId,
        query.after ?? null,
        query.search ?? null,
        query.limit + 1,
      ],
    )
  ).rows;
  const items = rows.slice(0, query.limit);
  return {
    items,
    nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
  };
}
