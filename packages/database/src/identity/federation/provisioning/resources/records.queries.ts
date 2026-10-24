import type { PoolClient } from 'pg';
import type { Filter } from 'scim2-parse-filter';
import {
  compileDirectoryFilter,
  directoryField,
  type DirectoryKind,
} from './filter.js';
import type { DirectoryGroupRow, DirectoryUserRow } from '../contract.js';
import type { DirectoryUser } from './users.repository.js';
import type { DirectoryGroup } from './groups.repository.js';

export type DirectoryQuery = Readonly<{
  filter?: Filter;
  startIndex: number;
  count: number;
  sortBy?: string;
  sortOrder: 'ascending' | 'descending';
}>;
export type DirectoryPage<T> = Readonly<{
  totalResults: number;
  startIndex: number;
  Resources: readonly T[];
}>;
const resourceTable = {
  User: 'app.auth_directory_users',
  Group: 'app.auth_directory_groups',
};

async function listRows<T extends DirectoryUserRow | DirectoryGroupRow>(
  client: PoolClient,
  organizationId: string,
  kind: DirectoryKind,
  query: DirectoryQuery,
): Promise<DirectoryPage<T>> {
  const parameters: unknown[] = [organizationId],
    filter = compileDirectoryFilter(kind, query.filter, parameters);
  const where = `resource.organization_id=$1 ${kind === 'User' ? 'and resource.deleted_at is null' : ''} and (${filter})`;
  const total =
    (
      await client.query<{ count: number }>(
        `select count(*)::integer count from ${resourceTable[kind]} resource where ${where}`,
        parameters,
      )
    ).rows[0]?.count ?? 0;
  if (query.count === 0)
    return { totalResults: total, startIndex: query.startIndex, Resources: [] };
  const sort = directoryField(kind, query.sortBy ?? 'id');
  const direction = query.sortOrder === 'descending' ? 'desc' : 'asc';
  const order =
    sort.caseExact || sort.type !== 'string' ? sort.sql : `lower(${sort.sql})`;
  parameters.push(query.count, query.startIndex - 1);
  const rows = (
    await client.query<T>(
      `select resource.* from ${resourceTable[kind]} resource where ${where}
    order by ${order} ${direction} nulls last,resource.id ${direction} limit $${String(parameters.length - 1)} offset $${String(parameters.length)}`,
      parameters,
    )
  ).rows;
  return { totalResults: total, startIndex: query.startIndex, Resources: rows };
}
export async function listDirectoryUsers(
  client: PoolClient,
  organizationId: string,
  query: DirectoryQuery,
): Promise<DirectoryPage<DirectoryUser>> {
  const page = await listRows<DirectoryUserRow>(
    client,
    organizationId,
    'User',
    query,
  );
  const members = (
    await client.query<{ directory_user_id: string; group_id: string }>(
      'select directory_user_id,group_id from app.auth_directory_group_members where organization_id=$1 and directory_user_id=any($2::uuid[]) order by group_id',
      [organizationId, page.Resources.map((user) => user.id)],
    )
  ).rows;
  const groups = Map.groupBy(members, (member) => member.directory_user_id);
  return {
    ...page,
    Resources: page.Resources.map((user) => ({
      ...user,
      groupIds: (groups.get(user.id) ?? []).map((member) => member.group_id),
    })),
  };
}
export async function listDirectoryGroups(
  client: PoolClient,
  organizationId: string,
  query: DirectoryQuery,
): Promise<DirectoryPage<DirectoryGroup>> {
  const page = await listRows<DirectoryGroupRow>(
    client,
    organizationId,
    'Group',
    query,
  );
  const members = (
    await client.query<{ directory_user_id: string; group_id: string }>(
      'select directory_user_id,group_id from app.auth_directory_group_members where organization_id=$1 and group_id=any($2::uuid[]) order by directory_user_id',
      [organizationId, page.Resources.map((group) => group.id)],
    )
  ).rows;
  const groups = Map.groupBy(members, (member) => member.group_id);
  return {
    ...page,
    Resources: page.Resources.map((group) => ({
      ...group,
      memberIds: (groups.get(group.id) ?? []).map(
        (member) => member.directory_user_id,
      ),
    })),
  };
}
