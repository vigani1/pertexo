import {
  workspaceMemberships,
  users,
  authDirectoryUsers,
  authDirectoryMemberships,
} from '@pertexo/database/schema';

import { and, eq, exists, isNull, sql } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import {
  rethrowQueryFailure,
  withWorkspaceScope,
} from '@pertexo/database/primitives';

import type { PoolClient } from 'pg';

/** Someone the directory holds and hasn't deleted; only one who has signed in has a user. */
export async function readAdoptableDirectoryUser(
  client: PoolClient,
  organizationId: string,
  directoryUserId: string,
) {
  const [row] = await drizzle(client)
    .select({
      user_id: authDirectoryUsers.userId,
      revision: authDirectoryUsers.revision,
    })
    .from(authDirectoryUsers)
    .where(
      and(
        eq(authDirectoryUsers.organizationId, organizationId),
        eq(authDirectoryUsers.id, directoryUserId),
        eq(authDirectoryUsers.active, true),
        isNull(authDirectoryUsers.deletedAt),
      ),
    )
    .catch(rethrowQueryFailure);
  return row;
}

/** The person's membership in the workspace, and whether the directory already manages it. */
export async function readWorkspaceMember(
  client: PoolClient,
  workspaceId: string,
  userId: string,
) {
  const member = await withWorkspaceScope(
    client,
    { workspaceId },
    async (scoped) => {
      const db = drizzle(scoped);
      const managed = db
        .select({ one: sql`1` })
        .from(authDirectoryMemberships)
        .where(
          and(
            eq(
              authDirectoryMemberships.workspaceId,
              workspaceMemberships.workspaceId,
            ),
            eq(authDirectoryMemberships.userId, workspaceMemberships.userId),
          ),
        );
      const [record] = await db
        .select({
          role: workspaceMemberships.role,
          status: workspaceMemberships.status,
          role_revision: workspaceMemberships.roleRevision,
          display_name: users.displayName,
          managed: sql<boolean>`${exists(managed)}`,
        })
        .from(workspaceMemberships)
        .innerJoin(users, eq(users.id, workspaceMemberships.userId))
        .where(
          and(
            eq(workspaceMemberships.workspaceId, workspaceId),
            eq(workspaceMemberships.userId, userId),
          ),
        )
        .catch(rethrowQueryFailure);
      return record;
    },
  );
  return member;
}
