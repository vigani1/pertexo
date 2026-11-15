import type {
  DirectoryQuery,
  DirectoryPage,
} from '../directory-provisioning.types.js';
import { authDirectoryGroupMembers } from '@pertexo/database/schema';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { directoryUsers, directoryGroups } from './tables.js';
import { drizzle } from 'drizzle-orm/node-postgres';

import type { PoolClient } from 'pg';

import type { SQL } from 'drizzle-orm';
import type { directoryField, DirectoryKind } from './filter.repository.js';

type ResolvedQuery = Readonly<{
  query: DirectoryQuery;
  filter: SQL;
  /** Undefined when the sort attribute can't be used; it only matters for a non-empty page. */
  sort: ReturnType<typeof directoryField>;
}>;

/** A page of directory rows, or `invalid_sort` when rows must be ordered by an unusable attribute. */
export async function listRows(
  client: PoolClient,
  organizationId: string,
  kind: 'User',
  resolved: ResolvedQuery,
): Promise<DirectoryPage<DirectoryUserRow> | 'invalid_sort'>;
export async function listRows(
  client: PoolClient,
  organizationId: string,
  kind: 'Group',
  resolved: ResolvedQuery,
): Promise<DirectoryPage<DirectoryGroupRow> | 'invalid_sort'>;
export async function listRows(
  client: PoolClient,
  organizationId: string,
  kind: DirectoryKind,
  resolved: ResolvedQuery,
): Promise<
  DirectoryPage<DirectoryUserRow | DirectoryGroupRow> | 'invalid_sort'
> {
  const { query } = resolved;
  const table = kind === 'User' ? directoryUsers : directoryGroups;
  const condition = and(
    eq(table.organizationId, organizationId),
    kind === 'User' ? isNull(directoryUsers.deletedAt) : undefined,
    resolved.filter,
  );
  const [total] = await drizzle(client)
    .select({ count: count() })
    .from(table)
    .where(condition)
    .catch(rethrowQueryFailure);
  if (query.count === 0)
    return {
      totalResults: total?.count ?? 0,
      startIndex: query.startIndex,
      Resources: [],
    };
  const sort = resolved.sort;
  if (sort === undefined) return 'invalid_sort';
  const order =
    sort.caseExact || sort.type !== 'string'
      ? sort.sql
      : sql`lower(${sort.sql})`;
  const ordering =
    query.sortOrder === 'descending'
      ? [sql`${order} desc nulls last`, desc(table.id)]
      : [sql`${order} asc nulls last`, asc(table.id)];
  const selected =
    kind === 'User'
      ? directoryUserRecords(client)
      : directoryGroupRecords(client);
  const rows = await selected
    .where(condition)
    .orderBy(...ordering)
    .limit(query.count)
    .offset(query.startIndex - 1)
    .catch(rethrowQueryFailure);
  return {
    totalResults: total?.count ?? 0,
    startIndex: query.startIndex,
    Resources: rows,
  };
}
/** Group memberships of the listed users, by group. */
export async function readUserGroupMembers(
  client: PoolClient,
  organizationId: string,
  userIds: readonly string[],
) {
  const members = await drizzle(client)
    .select({
      directory_user_id: authDirectoryGroupMembers.directoryUserId,
      group_id: authDirectoryGroupMembers.groupId,
    })
    .from(authDirectoryGroupMembers)
    .where(
      and(
        eq(authDirectoryGroupMembers.organizationId, organizationId),
        inArray(authDirectoryGroupMembers.directoryUserId, [...userIds]),
      ),
    )
    .orderBy(asc(authDirectoryGroupMembers.groupId))
    .catch(rethrowQueryFailure);
  return members;
}

/** Members of the listed groups, by user. */
export async function readGroupMembers(
  client: PoolClient,
  organizationId: string,
  groupIds: readonly string[],
) {
  const members = await drizzle(client)
    .select({
      directory_user_id: authDirectoryGroupMembers.directoryUserId,
      group_id: authDirectoryGroupMembers.groupId,
    })
    .from(authDirectoryGroupMembers)
    .where(
      and(
        eq(authDirectoryGroupMembers.organizationId, organizationId),
        inArray(authDirectoryGroupMembers.groupId, [...groupIds]),
      ),
    )
    .orderBy(asc(authDirectoryGroupMembers.directoryUserId))
    .catch(rethrowQueryFailure);
  return members;
}
export function directoryUserRecords(client: PoolClient) {
  return drizzle(client)
    .select({
      id: directoryUsers.id,
      organization_id: directoryUsers.organizationId,
      user_name: directoryUsers.userName,
      normalized_user_name: directoryUsers.normalizedUserName,
      login_email: directoryUsers.loginEmail,
      external_id: directoryUsers.externalId,
      active: directoryUsers.active,
      profile: directoryUsers.profile,
      user_id: directoryUsers.userId,
      revision: directoryUsers.revision,
      deleted_at: directoryUsers.deletedAt,
      created_at: directoryUsers.createdAt,
      updated_at: directoryUsers.updatedAt,
    })
    .from(directoryUsers);
}
export type DirectoryUserRow = Awaited<
  ReturnType<typeof directoryUserRecords>
>[number];
export function directoryGroupRecords(client: PoolClient) {
  return drizzle(client)
    .select({
      id: directoryGroups.id,
      organization_id: directoryGroups.organizationId,
      display_name: directoryGroups.displayName,
      external_id: directoryGroups.externalId,
      revision: directoryGroups.revision,
      created_at: directoryGroups.createdAt,
      updated_at: directoryGroups.updatedAt,
    })
    .from(directoryGroups);
}
export type DirectoryGroupRow = Awaited<
  ReturnType<typeof directoryGroupRecords>
>[number];
