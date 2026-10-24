import type { PoolClient } from 'pg';
import { appendAuditFacts } from '../../../../governance/audit/events.repository.js';
import { updateMemberships } from '../../../../tenant-access/members/records.repository.js';
import type { MembershipChange } from '../../../../tenant-access/members/contract.js';
import { revokeSessionsForUsers } from '../../../../tenant-access/users/sessions.repository.js';
import { withWorkspaceScope } from '../../../../tenant-access/transactions.js';
import type { DirectoryRole } from '../contract.js';

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
      await scoped.query<{ user_id: string }>(
        'select user_id from app.auth_directory_memberships where organization_id=$1 and workspace_id=$2 order by user_id limit $3',
        [organizationId, workspaceId, limit],
      )
    ).rows.map((row) => row.user_id);
    if (ids.length === 0) return 0;
    const members = (
      await scoped.query<{
        user_id: string;
        role: DirectoryRole;
        status: string;
        role_revision: number;
      }>(
        'select user_id,role,status,role_revision from app.workspace_memberships where workspace_id=$1 and user_id=any($2::uuid[]) order by user_id for update',
        [workspaceId, ids],
      )
    ).rows;
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
    await scoped.query(
      'delete from app.auth_directory_memberships where organization_id=$1 and workspace_id=$2 and user_id=any($3::uuid[])',
      [organizationId, workspaceId, ids],
    );
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
