import type { DirectoryGroup } from '../contract.js';
import { authDirectoryGroupMembers } from '../../../../schema/identity/federation/directory/members.js';
import { authDirectoryUsers } from '../../../../schema/identity/federation/directory/users.js';
import { authDirectoryGroups } from '../../../../schema/identity/federation/directory/groups.js';
import { authDirectoryGroupMappings } from '../../../../schema/identity/federation/directory/mappings.js';
import { authOrganizations } from '../../../../schema/identity/federation/organizations.js';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { directoryGroupRecords } from './records.queries.js';
import { directoryGroups } from './tables.js';
import { rethrowQueryFailure } from '../../../../platform/query-errors.js';
import { removeDirectoryFolderGrants } from '../../../../tenant-access/resources/revocation.repository.js';
import type { Pool, PoolClient } from 'pg';
import { generatePersistedId } from '../../../../platform/persisted-id.js';
import { withDirectoryTransaction } from '../authority.repository.js';
import { DirectoryError } from '../errors.js';
import type { DirectoryPrincipal, DirectoryGroupValues } from '../contract.js';

import { DIRECTORY_LIMITS } from '../limits.js';
import { projectDirectoryMemberships } from '../projection.repository.js';
import {
  assertDirectoryRevision,
  directoryAudit,
  withDirectoryConstraintErrors,
} from './shared.js';
export async function readDirectoryGroup(
  client: PoolClient,
  organizationId: string,
  id: string,
): Promise<DirectoryGroup> {
  const [group] = await directoryGroupRecords(client)
    .where(
      and(
        eq(directoryGroups.organizationId, organizationId),
        eq(directoryGroups.id, id),
      ),
    )
    .catch(rethrowQueryFailure);
  if (group === undefined) throw new DirectoryError('not_found');
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
  return {
    ...group,
    memberIds: members.map((member) => member.directory_user_id),
  };
}
async function replaceMembers(
  client: PoolClient,
  organizationId: string,
  groupId: string,
  memberIds: readonly string[],
): Promise<readonly string[]> {
  const existing = (
    await drizzle(client)
      .select({ id: authDirectoryGroupMembers.directoryUserId })
      .from(authDirectoryGroupMembers)
      .where(
        and(
          eq(authDirectoryGroupMembers.organizationId, organizationId),
          eq(authDirectoryGroupMembers.groupId, groupId),
        ),
      )
      .catch(rethrowQueryFailure)
  ).map((member) => member.id);
  const valid = await drizzle(client)
    .select({ id: authDirectoryUsers.id })
    .from(authDirectoryUsers)
    .where(
      and(
        eq(authDirectoryUsers.organizationId, organizationId),
        inArray(authDirectoryUsers.id, memberIds),
        isNull(authDirectoryUsers.deletedAt),
      ),
    )
    .catch(rethrowQueryFailure);
  if (valid.length !== memberIds.length)
    throw new DirectoryError('invalid_value');
  const before = new Set(existing),
    after = new Set(memberIds);
  const changed = [
    ...existing.filter((id) => !after.has(id)),
    ...memberIds.filter((id) => !before.has(id)),
  ];
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
      .from(sql`unnest(${sql.param(memberIds)}::uuid[]) as member(id)`);
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
        inArray(authDirectoryUsers.id, changed),
      ),
    )
    .catch(rethrowQueryFailure);
  return changed;
}
export function createDirectoryGroup(
  pool: Pool,
  principal: DirectoryPrincipal,
  values: DirectoryGroupValues,
): Promise<DirectoryGroup> {
  return withDirectoryConstraintErrors(() =>
    withDirectoryTransaction(pool, principal, async (client, organization) => {
      const [row] = await drizzle(client)
        .select({ count: count() })
        .from(authDirectoryGroups)
        .where(eq(authDirectoryGroups.organizationId, principal.organizationId))
        .catch(rethrowQueryFailure);
      if ((row?.count ?? 0) >= DIRECTORY_LIMITS.groups)
        throw new DirectoryError('limit');
      const id = generatePersistedId();
      await drizzle(client)
        .insert(authDirectoryGroups)
        .values({
          id,
          organizationId: principal.organizationId,
          displayName: values.displayName,
          externalId: values.externalId,
        })
        .catch(rethrowQueryFailure);
      const affected = await replaceMembers(
        client,
        principal.organizationId,
        id,
        values.memberIds,
      );
      await projectDirectoryMemberships(
        client,
        organization,
        {
          credentialId: principal.credentialId,
        },
        affected,
      );
      await directoryAudit(
        client,
        principal,
        'identity.directory_group_created',
        id,
      );
      return readDirectoryGroup(client, principal.organizationId, id);
    }),
  );
}
export function changeDirectoryGroup(
  pool: Pool,
  principal: DirectoryPrincipal,
  {
    id,
    expectedRevision,
    transform,
  }: Readonly<{
    id: string;
    expectedRevision: number | undefined;
    transform: (current: DirectoryGroup) => DirectoryGroupValues;
  }>,
): Promise<DirectoryGroup> {
  return withDirectoryConstraintErrors(() =>
    withDirectoryTransaction(pool, principal, async (client, organization) => {
      const current = await readDirectoryGroup(
        client,
        principal.organizationId,
        id,
      );
      assertDirectoryRevision(current.revision, expectedRevision);
      const values = transform(current);
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
            eq(authDirectoryGroups.organizationId, principal.organizationId),
            eq(authDirectoryGroups.id, id),
          ),
        )
        .catch(rethrowQueryFailure);
      const affected = await replaceMembers(
        client,
        principal.organizationId,
        id,
        values.memberIds,
      );
      await projectDirectoryMemberships(
        client,
        organization,
        {
          credentialId: principal.credentialId,
        },
        affected,
      );
      await directoryAudit(
        client,
        principal,
        'identity.directory_group_changed',
        id,
      );
      return readDirectoryGroup(client, principal.organizationId, id);
    }),
  );
}
export function deleteDirectoryGroup(
  pool: Pool,
  principal: DirectoryPrincipal,
  id: string,
  expectedRevision: number | undefined,
): Promise<void> {
  return withDirectoryTransaction(
    pool,
    principal,
    async (client, organization) => {
      const group = await readDirectoryGroup(
        client,
        principal.organizationId,
        id,
      );
      assertDirectoryRevision(group.revision, expectedRevision);
      const mapped =
        (
          await drizzle(client)
            .select({ one: sql`1` })
            .from(authDirectoryGroupMappings)
            .where(
              and(
                eq(
                  authDirectoryGroupMappings.organizationId,
                  principal.organizationId,
                ),
                eq(authDirectoryGroupMappings.groupId, id),
              ),
            )
            .limit(1)
            .catch(rethrowQueryFailure)
        ).length !== 0;
      const affected = await replaceMembers(
        client,
        principal.organizationId,
        id,
        [],
      );
      await removeDirectoryFolderGrants(
        client,
        organization.id,
        organization.workspaces.map((workspace) => workspace.workspace_id),
        id,
      );
      await drizzle(client)
        .delete(authDirectoryGroups)
        .where(
          and(
            eq(authDirectoryGroups.organizationId, principal.organizationId),
            eq(authDirectoryGroups.id, id),
          ),
        )
        .catch(rethrowQueryFailure);
      if (mapped)
        await drizzle(client)
          .update(authOrganizations)
          .set({ revision: sql`${authOrganizations.revision}+1` })
          .where(eq(authOrganizations.id, principal.organizationId))
          .catch(rethrowQueryFailure);
      await projectDirectoryMemberships(
        client,
        organization,
        {
          credentialId: principal.credentialId,
        },
        affected,
      );
      await directoryAudit(
        client,
        principal,
        'identity.directory_group_deleted',
        id,
      );
    },
  );
}
