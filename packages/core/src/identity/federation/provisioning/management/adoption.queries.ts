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
import { DirectoryError } from '../errors.js';
import type { DirectoryOrganization } from '../contract.js';
import { readDirectoryRole } from '../roles.queries.js';
import { judgeAdoption } from './adoption.js';
import type {
  DirectoryAdoptionQuery,
  DirectoryAdoptionPreview,
} from '@pertexo/contracts';

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

/** The preview is advisory; adoption rechecks every reviewed revision under write locks. */
export async function previewDirectoryAdoption(
  client: PoolClient,
  organization: DirectoryOrganization,
  {
    canManage,
    query,
  }: Readonly<{ canManage: boolean; query: DirectoryAdoptionQuery }>,
): Promise<DirectoryAdoptionPreview> {
  if (!canManage) throw new DirectoryError('forbidden');
  const workspace = organization.workspaces.find(
    (entry) => entry.workspace_id === query.targetWorkspaceId,
  );
  if (workspace === undefined) throw new DirectoryError('not_found');
  const directory = await readAdoptableDirectoryUser(
    client,
    organization.id,
    query.directoryUserId,
  );
  if (directory?.user_id === null || directory === undefined)
    return {
      eligible: false,
      reason:
        'This person must complete organization SSO before an existing membership can be adopted.',
    };
  const userId = directory.user_id;
  const member = await withWorkspaceScope(
    client,
    { workspaceId: workspace.workspace_id },
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
            eq(workspaceMemberships.workspaceId, workspace.workspace_id),
            eq(workspaceMemberships.userId, userId),
          ),
        )
        .catch(rethrowQueryFailure);
      return record;
    },
  );
  const judged = judgeAdoption(member);
  if (!judged.eligible) return judged;
  const role = await readDirectoryRole(client, organization.id, {
    workspaceId: workspace.workspace_id,
    directoryUserId: query.directoryUserId,
    fallback: workspace.default_role,
  });
  return {
    eligible: true,
    displayName: judged.member.display_name,
    currentRole: judged.member.role,
    command: {
      ...query,
      expectedRevision: organization.revision,
      directoryRevision: directory.revision,
      membershipRevision: judged.member.role_revision,
      role,
    },
  };
}
