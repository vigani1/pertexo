import type { DirectoryQuery, DirectoryPage } from '../contract.js';
import { authDirectoryGroupMembers } from '../../../../schema/identity/federation/directory/members.js';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { rethrowQueryFailure } from '../../../../platform/query-errors.js';
import { directoryUsers, directoryGroups } from './tables.js';
import { drizzle } from 'drizzle-orm/node-postgres';

import type { PoolClient } from 'pg';

import {
  compileDirectoryFilter,
  directoryField,
  type DirectoryKind,
} from './filter.js';

import type { DirectoryUser } from '../contract.js';
import type { DirectoryGroup } from '../contract.js';
async function listRows(
  client: PoolClient,
  organizationId: string,
  kind: 'User',
  query: DirectoryQuery,
): Promise<DirectoryPage<DirectoryUserRow>>;
async function listRows(
  client: PoolClient,
  organizationId: string,
  kind: 'Group',
  query: DirectoryQuery,
): Promise<DirectoryPage<DirectoryGroupRow>>;
async function listRows(
  client: PoolClient,
  organizationId: string,
  kind: DirectoryKind,
  query: DirectoryQuery,
): Promise<DirectoryPage<DirectoryUserRow | DirectoryGroupRow>> {
  const table = kind === 'User' ? directoryUsers : directoryGroups;
  const condition = and(
    eq(table.organizationId, organizationId),
    kind === 'User' ? isNull(directoryUsers.deletedAt) : undefined,
    compileDirectoryFilter(kind, query.filter),
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
  const sort = directoryField(kind, query.sortBy ?? 'id');
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
export async function listDirectoryUsers(
  client: PoolClient,
  organizationId: string,
  query: DirectoryQuery,
): Promise<DirectoryPage<DirectoryUser>> {
  const page = await listRows(client, organizationId, 'User', query);
  const members = await drizzle(client)
    .select({
      directory_user_id: authDirectoryGroupMembers.directoryUserId,
      group_id: authDirectoryGroupMembers.groupId,
    })
    .from(authDirectoryGroupMembers)
    .where(
      and(
        eq(authDirectoryGroupMembers.organizationId, organizationId),
        inArray(
          authDirectoryGroupMembers.directoryUserId,
          page.Resources.map((user) => user.id),
        ),
      ),
    )
    .orderBy(asc(authDirectoryGroupMembers.groupId))
    .catch(rethrowQueryFailure);
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
  const page = await listRows(client, organizationId, 'Group', query);
  const members = await drizzle(client)
    .select({
      directory_user_id: authDirectoryGroupMembers.directoryUserId,
      group_id: authDirectoryGroupMembers.groupId,
    })
    .from(authDirectoryGroupMembers)
    .where(
      and(
        eq(authDirectoryGroupMembers.organizationId, organizationId),
        inArray(
          authDirectoryGroupMembers.groupId,
          page.Resources.map((group) => group.id),
        ),
      ),
    )
    .orderBy(asc(authDirectoryGroupMembers.directoryUserId))
    .catch(rethrowQueryFailure);
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
