import {
  authDirectoryGroupMembers,
  authDirectoryUsers,
  authDirectoryGroups,
  authDirectoryGroupMappings,
  authOrganizations,
} from '@pertexo/database/schema';

import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import { directoryGroupRecords } from './directory-resources.repository.js';

import { directoryGroups } from './tables.js';

import { rethrowQueryFailure } from '@pertexo/database/primitives';

import type { PoolClient } from 'pg';

import type { DirectoryGroupValues } from '../directory-provisioning.types.js';

export async function findDirectoryGroup(
  client: PoolClient,
  organizationId: string,
  id: string,
) {
  const [group] = await directoryGroupRecords(client)
    .where(
      and(
        eq(directoryGroups.organizationId, organizationId),
        eq(directoryGroups.id, id),
      ),
    )
    .catch(rethrowQueryFailure);
  return group;
}

export async function readGroupMemberIds(
  client: PoolClient,
  organizationId: string,
  id: string,
): Promise<string[]> {
  const members = await drizzle(client)
    .select({ directory_user_id: authDirectoryGroupMembers.directoryUserId })
    .from(authDirectoryGroupMembers)
    .where(
      and(
        eq(authDirectoryGroupMembers.organizationId, organizationId),
        eq(authDirectoryGroupMembers.groupId, id),
      ),
    )
    .orderBy(asc(authDirectoryGroupMembers.directoryUserId))
    .catch(rethrowQueryFailure);
  return members.map((member) => member.directory_user_id);
}

export async function readCurrentMemberIds(
  client: PoolClient,
  organizationId: string,
  groupId: string,
): Promise<string[]> {
  const existing = await drizzle(client)
    .select({ id: authDirectoryGroupMembers.directoryUserId })
    .from(authDirectoryGroupMembers)
    .where(
      and(
        eq(authDirectoryGroupMembers.organizationId, organizationId),
        eq(authDirectoryGroupMembers.groupId, groupId),
      ),
    )
    .catch(rethrowQueryFailure);
  return existing.map((member) => member.id);
}

/** How many of the IDs are live users of this organization's directory. */
export async function countLiveMembers(
  client: PoolClient,
  organizationId: string,
  memberIds: readonly string[],
): Promise<number> {
  const valid = await drizzle(client)
    .select({ id: authDirectoryUsers.id })
    .from(authDirectoryUsers)
    .where(
      and(
        eq(authDirectoryUsers.organizationId, organizationId),
        inArray(authDirectoryUsers.id, [...memberIds]),
        isNull(authDirectoryUsers.deletedAt),
      ),
    )
    .catch(rethrowQueryFailure);
  return valid.length;
}

/** Replaces the group's members and moves the revision of every user whose groups changed. */
export async function writeGroupMembers(
  client: PoolClient,
  organizationId: string,
  groupId: string,
  {
    memberIds,
    changed,
  }: Readonly<{ memberIds: readonly string[]; changed: readonly string[] }>,
): Promise<void> {
  const db = drizzle(client);
  await db
    .delete(authDirectoryGroupMembers)
    .where(
      and(
        eq(authDirectoryGroupMembers.organizationId, organizationId),
        eq(authDirectoryGroupMembers.groupId, groupId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (memberIds.length > 0) {
    const source = db
      .select({
        organizationId: sql<string>`${organizationId}::uuid`.as(
          'organization_id',
        ),
        groupId: sql<string>`${groupId}::uuid`.as('group_id'),
        directoryUserId: sql<string>`member.id`.as('directory_user_id'),
      })
      .from(sql`unnest(${sql.param([...memberIds])}::uuid[]) as member(id)`);
    await db
      .insert(authDirectoryGroupMembers)
      .select(source)
      .catch(rethrowQueryFailure);
  }
  await db
    .update(authDirectoryUsers)
    .set({
      revision: sql`${authDirectoryUsers.revision}+1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(authDirectoryUsers.organizationId, organizationId),
        inArray(authDirectoryUsers.id, [...changed]),
      ),
    )
    .catch(rethrowQueryFailure);
}

export async function countDirectoryGroups(
  client: PoolClient,
  organizationId: string,
): Promise<number> {
  const [row] = await drizzle(client)
    .select({ count: count() })
    .from(authDirectoryGroups)
    .where(eq(authDirectoryGroups.organizationId, organizationId))
    .catch(rethrowQueryFailure);
  return row?.count ?? 0;
}

export async function insertDirectoryGroup(
  client: PoolClient,
  organizationId: string,
  { id, values }: Readonly<{ id: string; values: DirectoryGroupValues }>,
): Promise<void> {
  await drizzle(client)
    .insert(authDirectoryGroups)
    .values({
      id,
      organizationId: organizationId,
      displayName: values.displayName,
      externalId: values.externalId,
    })
    .catch(rethrowQueryFailure);
}

export async function updateDirectoryGroup(
  client: PoolClient,
  organizationId: string,
  { id, values }: Readonly<{ id: string; values: DirectoryGroupValues }>,
): Promise<void> {
  await drizzle(client)
    .update(authDirectoryGroups)
    .set({
      displayName: values.displayName,
      externalId: values.externalId,
      revision: sql`${authDirectoryGroups.revision}+1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(authDirectoryGroups.organizationId, organizationId),
        eq(authDirectoryGroups.id, id),
      ),
    )
    .catch(rethrowQueryFailure);
}

export async function groupIsMapped(
  client: PoolClient,
  organizationId: string,
  id: string,
): Promise<boolean> {
  return (
    (
      await drizzle(client)
        .select({ one: sql`1` })
        .from(authDirectoryGroupMappings)
        .where(
          and(
            eq(authDirectoryGroupMappings.organizationId, organizationId),
            eq(authDirectoryGroupMappings.groupId, id),
          ),
        )
        .limit(1)
        .catch(rethrowQueryFailure)
    ).length !== 0
  );
}

/** Deletes the group; a mapped one also moves the organization's revision. */
export async function deleteDirectoryGroupRow(
  client: PoolClient,
  organizationId: string,
  { id, mapped }: Readonly<{ id: string; mapped: boolean }>,
): Promise<void> {
  await drizzle(client)
    .delete(authDirectoryGroups)
    .where(
      and(
        eq(authDirectoryGroups.organizationId, organizationId),
        eq(authDirectoryGroups.id, id),
      ),
    )
    .catch(rethrowQueryFailure);
  if (mapped)
    await drizzle(client)
      .update(authOrganizations)
      .set({ revision: sql`${authOrganizations.revision}+1` })
      .where(eq(authOrganizations.id, organizationId))
      .catch(rethrowQueryFailure);
}
