import { canonicalEmail } from '@pertexo/workflow-model';
import type { DirectoryUser } from '../contract.js';
import {
  authDirectoryGroupMembers,
  authDirectoryUsers,
  authDirectoryGroups,
} from '@pertexo/database/schema';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { directoryUserRecords } from './records.queries.js';
import { directoryUsers } from './tables.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { Pool, PoolClient } from 'pg';
import { generatePersistedId } from '@pertexo/database/platform';
import { withDirectoryTransaction } from '../authority.repository.js';
import { DirectoryError } from '../errors.js';
import type { DirectoryPrincipal, DirectoryUserValues } from '../contract.js';

import { DIRECTORY_LIMITS } from '@pertexo/workflow-model';
import { projectDirectoryMemberships } from '../projection.repository.js';
import {
  assertDirectoryRevision,
  directoryAudit,
  withDirectoryConstraintErrors,
} from './shared.js';
export async function readDirectoryUser(
  client: PoolClient,
  organizationId: string,
  id: string,
): Promise<DirectoryUser> {
  const [user] = await directoryUserRecords(client)
    .where(
      and(
        eq(directoryUsers.organizationId, organizationId),
        eq(directoryUsers.id, id),
        isNull(directoryUsers.deletedAt),
      ),
    )
    .catch(rethrowQueryFailure);
  if (user === undefined) throw new DirectoryError('not_found');
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
  return { ...user, groupIds: groups.map((group) => group.group_id) };
}
export function createDirectoryUser(
  pool: Pool,
  principal: DirectoryPrincipal,
  values: DirectoryUserValues,
): Promise<DirectoryUser> {
  return withDirectoryConstraintErrors(() =>
    withDirectoryTransaction(pool, principal, async (client) => {
      const [row] = await drizzle(client)
        .select({ count: count() })
        .from(authDirectoryUsers)
        .where(eq(authDirectoryUsers.organizationId, principal.organizationId))
        .catch(rethrowQueryFailure);
      if ((row?.count ?? 0) >= DIRECTORY_LIMITS.users)
        throw new DirectoryError('limit');
      const id = generatePersistedId();
      await drizzle(client)
        .insert(authDirectoryUsers)
        .values({
          id,
          organizationId: principal.organizationId,
          userName: values.userName,
          normalizedUserName: values.userName.toLowerCase(),
          loginEmail: canonicalEmail(values.profile.emails[0].value),
          externalId: values.externalId,
          active: values.active,
          profile: values.profile,
        })
        .catch(rethrowQueryFailure);
      await directoryAudit(
        client,
        principal,
        'identity.directory_user_created',
        id,
      );
      return readDirectoryUser(client, principal.organizationId, id);
    }),
  );
}
/** PATCH transforms the current resource under the same lock as If-Match and persistence. */
export function changeDirectoryUser(
  pool: Pool,
  principal: DirectoryPrincipal,
  {
    id,
    expectedRevision,
    transform,
  }: Readonly<{
    id: string;
    expectedRevision: number | undefined;
    transform: (current: DirectoryUser) => DirectoryUserValues;
  }>,
): Promise<DirectoryUser> {
  return withDirectoryConstraintErrors(() =>
    withDirectoryTransaction(pool, principal, async (client, organization) => {
      const current = await readDirectoryUser(
        client,
        principal.organizationId,
        id,
      );
      assertDirectoryRevision(current.revision, expectedRevision);
      const values = transform(current);
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
            eq(authDirectoryUsers.organizationId, principal.organizationId),
            eq(authDirectoryUsers.id, id),
          ),
        )
        .catch(rethrowQueryFailure);
      if (current.user_id !== null)
        await projectDirectoryMemberships(
          client,
          organization,
          { credentialId: principal.credentialId },
          [current.id],
        );
      await directoryAudit(
        client,
        principal,
        'identity.directory_user_changed',
        id,
      );
      return readDirectoryUser(client, principal.organizationId, id);
    }),
  );
}
export function deleteDirectoryUser(
  pool: Pool,
  principal: DirectoryPrincipal,
  id: string,
  expectedRevision: number | undefined,
): Promise<void> {
  return withDirectoryTransaction(
    pool,
    principal,
    async (client, organization) => {
      const user = await readDirectoryUser(
        client,
        principal.organizationId,
        id,
      );
      assertDirectoryRevision(user.revision, expectedRevision);
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
            eq(authDirectoryUsers.organizationId, principal.organizationId),
            eq(authDirectoryUsers.id, id),
          ),
        )
        .catch(rethrowQueryFailure);
      const groups = await drizzle(client)
        .delete(authDirectoryGroupMembers)
        .where(
          and(
            eq(
              authDirectoryGroupMembers.organizationId,
              principal.organizationId,
            ),
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
            eq(authDirectoryGroups.organizationId, principal.organizationId),
            inArray(
              authDirectoryGroups.id,
              groups.map((group) => group.group_id),
            ),
          ),
        )
        .catch(rethrowQueryFailure);
      if (user.user_id !== null)
        await projectDirectoryMemberships(
          client,
          organization,
          { credentialId: principal.credentialId },
          [user.id],
        );
      await directoryAudit(
        client,
        principal,
        'identity.directory_user_deleted',
        id,
      );
    },
  );
}
