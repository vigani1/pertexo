import { workspaceMemberships, users } from '../../../../schema/foundation.js';
import { authDirectoryUsers } from '../../../../schema/identity/federation/directory/users.js';
import { authDirectoryMemberships } from '../../../../schema/identity/federation/directory/sources.js';
import { and, eq, exists, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { withWorkspaceScope } from '../../../../tenant-access/transactions.js';
import { DirectoryError } from '../errors.js';
import type { DirectoryOrganization } from '../contract.js';
import { readDirectoryRole } from '../roles.queries.js';
import type {
  DirectoryAdoptionQuery,
  DirectoryAdoptionPreview,
} from '@pertexo/contracts';

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
  const [directory] = await drizzle(client)
    .select({
      user_id: authDirectoryUsers.userId,
      revision: authDirectoryUsers.revision,
    })
    .from(authDirectoryUsers)
    .where(
      and(
        eq(authDirectoryUsers.organizationId, organization.id),
        eq(authDirectoryUsers.id, query.directoryUserId),
        eq(authDirectoryUsers.active, true),
        isNull(authDirectoryUsers.deletedAt),
      ),
    )
    .catch(rethrowQueryFailure);
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
  if (member?.role === 'owner')
    return {
      eligible: false,
      reason: 'Keep the recovery owner outside directory management.',
    };
  if (member?.status !== 'active')
    return {
      eligible: false,
      reason:
        'Only an active manual membership can be adopted. Reactivate an existing suspended or removed membership first.',
    };
  if (member.managed)
    return {
      eligible: false,
      reason: 'This membership is already directory-managed.',
    };
  const role = await readDirectoryRole(client, organization.id, {
    workspaceId: workspace.workspace_id,
    directoryUserId: query.directoryUserId,
    fallback: workspace.default_role,
  });
  return {
    eligible: true,
    displayName: member.display_name,
    currentRole: member.role,
    command: {
      ...query,
      expectedRevision: organization.revision,
      directoryRevision: directory.revision,
      membershipRevision: member.role_revision,
      role,
    },
  };
}
