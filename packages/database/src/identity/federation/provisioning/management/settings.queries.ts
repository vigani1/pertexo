import { authDirectoryGroups } from '../../../../schema/identity/federation/directory/groups.js';
import { authDirectoryUsers } from '../../../../schema/identity/federation/directory/users.js';
import { authProvisioningCredentials } from '../../../../schema/identity/federation/directory/credentials.js';
import { authDirectoryGroupMembers } from '../../../../schema/identity/federation/directory/members.js';
import { authDirectoryGroupMappings } from '../../../../schema/identity/federation/directory/mappings.js';
import { and, asc, count, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { credentialRecords } from './credentials.queries.js';
import { rethrowQueryFailure } from '../../../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import type {
  DirectorySettings,
  DirectoryPeopleQuery,
} from '@pertexo/contracts';
import type { DirectoryOrganization } from '../contract.js';
import { publicCredential } from './credentials.queries.js';

export async function projectDirectorySettings(
  client: PoolClient,
  organization: DirectoryOrganization,
  { canManage }: Readonly<{ canManage: boolean }>,
): Promise<DirectorySettings> {
  const db = drizzle(client);
  const groupCount = db
    .select({ count: count() })
    .from(authDirectoryGroups)
    .where(eq(authDirectoryGroups.organizationId, organization.id));
  const [counts] = await db
    .select({
      users: count(),
      activeUsers: sql<number>`count(*) filter(where ${authDirectoryUsers.active} and ${authDirectoryUsers.deletedAt} is null)::integer`,
      groups: sql<number>`(${groupCount})::integer`,
    })
    .from(authDirectoryUsers)
    .where(eq(authDirectoryUsers.organizationId, organization.id))
    .catch(rethrowQueryFailure);
  if (counts === undefined) throw new Error('Directory counts returned no row');
  const credentials = await credentialRecords(client)
    .where(eq(authProvisioningCredentials.organizationId, organization.id))
    .orderBy(
      desc(isNull(authProvisioningCredentials.revokedAt)),
      desc(authProvisioningCredentials.createdAt),
      desc(authProvisioningCredentials.id),
    )
    .limit(50)
    .catch(rethrowQueryFailure);
  const groups = await db
    .select({
      id: authDirectoryGroups.id,
      displayName: authDirectoryGroups.displayName,
      memberCount: count(authDirectoryGroupMembers.directoryUserId),
    })
    .from(authDirectoryGroups)
    .leftJoin(
      authDirectoryGroupMembers,
      and(
        eq(
          authDirectoryGroupMembers.organizationId,
          authDirectoryGroups.organizationId,
        ),
        eq(authDirectoryGroupMembers.groupId, authDirectoryGroups.id),
      ),
    )
    .where(eq(authDirectoryGroups.organizationId, organization.id))
    .groupBy(authDirectoryGroups.id)
    .orderBy(asc(authDirectoryGroups.displayName), asc(authDirectoryGroups.id))
    .catch(rethrowQueryFailure);
  const mappings = await db
    .select({
      groupId: authDirectoryGroupMappings.groupId,
      workspaceId: authDirectoryGroupMappings.workspaceId,
      role: authDirectoryGroupMappings.role,
      priority: authDirectoryGroupMappings.priority,
    })
    .from(authDirectoryGroupMappings)
    .where(eq(authDirectoryGroupMappings.organizationId, organization.id))
    .orderBy(
      asc(authDirectoryGroupMappings.workspaceId),
      asc(authDirectoryGroupMappings.priority),
    )
    .catch(rethrowQueryFailure);
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
  const rows = await drizzle(client)
    .select({
      id: authDirectoryUsers.id,
      userName: authDirectoryUsers.userName,
      email: authDirectoryUsers.loginEmail,
      active: authDirectoryUsers.active,
      boundUserId: authDirectoryUsers.userId,
      revision: authDirectoryUsers.revision,
      deleted: sql<boolean>`${authDirectoryUsers.deletedAt} is not null`,
    })
    .from(authDirectoryUsers)
    .where(
      and(
        eq(authDirectoryUsers.organizationId, organizationId),
        query.after === undefined
          ? undefined
          : gt(authDirectoryUsers.id, query.after),
        query.search === undefined
          ? undefined
          : sql`(strpos(lower(${authDirectoryUsers.userName}),lower(${query.search}))>0 or strpos(${authDirectoryUsers.loginEmail},lower(${query.search}))>0)`,
      ),
    )
    .orderBy(asc(authDirectoryUsers.id))
    .limit(query.limit + 1)
    .catch(rethrowQueryFailure);
  const items = rows.slice(0, query.limit);
  return {
    items,
    nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
  };
}
