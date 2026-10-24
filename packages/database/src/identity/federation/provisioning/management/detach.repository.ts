import { authDirectoryMemberships } from '../../../../schema/identity/federation/directory/sources.js';
import { workspaceMemberships } from '../../../../schema/foundation.js';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { appendAuditFacts } from '../../../../governance/audit/events.repository.js';
import { updateMemberships } from '../../../../tenant-access/members/records.repository.js';
import type { MembershipChange } from '../../../../tenant-access/members/contract.js';
import { revokeSessionsForUsers } from '../../../../tenant-access/users/sessions.repository.js';
import { withWorkspaceScope } from '../../../../tenant-access/transactions.js';

/** Detaching a source must remove its grant first; otherwise it silently becomes manual. */
export async function detachDirectoryMemberships(
  client: PoolClient,
  organizationId: string,
  {
    workspaceId,
    limit,
    actorId,
  }: Readonly<{
    workspaceId: string;
    limit: number;
    actorId?: string | undefined;
  }>,
): Promise<number> {
  return withWorkspaceScope(client, { workspaceId }, async (scoped) => {
    const ids = (
      await drizzle(scoped)
        .select({ user_id: authDirectoryMemberships.userId })
        .from(authDirectoryMemberships)
        .where(
          and(
            eq(authDirectoryMemberships.organizationId, organizationId),
            eq(authDirectoryMemberships.workspaceId, workspaceId),
          ),
        )
        .orderBy(asc(authDirectoryMemberships.userId))
        .limit(limit)
        .catch(rethrowQueryFailure)
    ).map((row) => row.user_id);
    if (ids.length === 0) return 0;
    const members = await drizzle(scoped)
      .select({
        user_id: workspaceMemberships.userId,
        role: workspaceMemberships.role,
        status: workspaceMemberships.status,
        role_revision: workspaceMemberships.roleRevision,
      })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          inArray(workspaceMemberships.userId, ids),
        ),
      )
      .orderBy(asc(workspaceMemberships.userId))
      .for('update')
      .catch(rethrowQueryFailure);
    const changes: MembershipChange[] = members
      .filter((member) => member.status !== 'removed')
      .map((member) => ({
        userId: member.user_id,
        role: member.role,
        status: 'removed',
        roleRevision: member.role_revision + 1,
      }));
    await updateMemberships(scoped, workspaceId, changes);
    await revokeSessionsForUsers(scoped, ids);
    await drizzle(scoped)
      .delete(authDirectoryMemberships)
      .where(
        and(
          eq(authDirectoryMemberships.organizationId, organizationId),
          eq(authDirectoryMemberships.workspaceId, workspaceId),
          inArray(authDirectoryMemberships.userId, ids),
        ),
      )
      .catch(rethrowQueryFailure);
    await appendAuditFacts(
      scoped,
      members.map((member) => ({
        workspaceId,
        actorId: actorId ?? null,
        action: 'identity.directory_membership_detached',
        targetType: 'workspace_member',
        targetId: member.user_id,
        metadata: { organizationId, status: 'removed' },
      })),
    );
    return ids.length;
  });
}
