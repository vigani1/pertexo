import { canonicalEmail } from '../../../email-policy.js';
import {
  authDirectoryGroupMembers,
  authDirectoryUsers,
  authDirectoryGroups,
} from '@pertexo/database/schema';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { directoryUserRecords } from './directory-resources.repository.js';
import { directoryUsers } from './tables.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { DirectoryUserValues } from '../directory-provisioning.types.js';

export async function findDirectoryUser(
  client: PoolClient,
  organizationId: string,
  id: string,
) {
  const [user] = await directoryUserRecords(client)
    .where(
      and(
        eq(directoryUsers.organizationId, organizationId),
        eq(directoryUsers.id, id),
        isNull(directoryUsers.deletedAt),
      ),
    )
    .catch(rethrowQueryFailure);
  return user;
}

export async function readUserGroupIds(
  client: PoolClient,
  organizationId: string,
  id: string,
): Promise<string[]> {
  const groups = await drizzle(client)
    .select({ group_id: authDirectoryGroupMembers.groupId })
    .from(authDirectoryGroupMembers)
    .where(
      and(
        eq(authDirectoryGroupMembers.organizationId, organizationId),
        eq(authDirectoryGroupMembers.directoryUserId, id),
      ),
    )
    .orderBy(asc(authDirectoryGroupMembers.groupId))
    .catch(rethrowQueryFailure);
  return groups.map((group) => group.group_id);
}

export async function countLiveDirectoryUsers(
  client: PoolClient,
  organizationId: string,
): Promise<number> {
  const [row] = await drizzle(client)
    .select({ count: count() })
    .from(authDirectoryUsers)
    .where(
      and(
        eq(authDirectoryUsers.organizationId, organizationId),
        isNull(authDirectoryUsers.deletedAt),
      ),
    )
    .catch(rethrowQueryFailure);
  return row?.count ?? 0;
}

export async function insertDirectoryUser(
  client: PoolClient,
  organizationId: string,
  { id, values }: Readonly<{ id: string; values: DirectoryUserValues }>,
): Promise<void> {
  await drizzle(client)
    .insert(authDirectoryUsers)
    .values({
      id,
      organizationId: organizationId,
      userName: values.userName,
      normalizedUserName: values.userName.toLowerCase(),
      loginEmail: canonicalEmail(values.profile.emails[0].value),
      externalId: values.externalId,
      active: values.active,
      profile: values.profile,
    })
    .catch(rethrowQueryFailure);
}

export async function updateDirectoryUser(
  client: PoolClient,
  organizationId: string,
  { id, values }: Readonly<{ id: string; values: DirectoryUserValues }>,
): Promise<void> {
  await drizzle(client)
    .update(authDirectoryUsers)
    .set({
      userName: values.userName,
      normalizedUserName: values.userName.toLowerCase(),
      loginEmail: canonicalEmail(values.profile.emails[0].value),
      externalId: values.externalId,
      active: values.active,
      profile: values.profile,
      revision: sql`${authDirectoryUsers.revision}+1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(authDirectoryUsers.organizationId, organizationId),
        eq(authDirectoryUsers.id, id),
      ),
    )
    .catch(rethrowQueryFailure);
}

/** Deactivates the user, removes it from its groups and moves those groups' revisions. */
export async function deleteDirectoryUserRow(
  client: PoolClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await drizzle(client)
    .update(authDirectoryUsers)
    .set({
      active: false,
      deletedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
      revision: sql`${authDirectoryUsers.revision}+1`,
    })
    .where(
      and(
        eq(authDirectoryUsers.organizationId, organizationId),
        eq(authDirectoryUsers.id, id),
      ),
    )
    .catch(rethrowQueryFailure);
  const groups = await drizzle(client)
    .delete(authDirectoryGroupMembers)
    .where(
      and(
        eq(authDirectoryGroupMembers.organizationId, organizationId),
        eq(authDirectoryGroupMembers.directoryUserId, id),
      ),
    )
    .returning({ group_id: authDirectoryGroupMembers.groupId })
    .catch(rethrowQueryFailure);
  await drizzle(client)
    .update(authDirectoryGroups)
    .set({
      revision: sql`${authDirectoryGroups.revision}+1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(authDirectoryGroups.organizationId, organizationId),
        inArray(
          authDirectoryGroups.id,
          groups.map((group) => group.group_id),
        ),
      ),
    )
    .catch(rethrowQueryFailure);
}
