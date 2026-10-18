import type { PoolClient } from 'pg';
import type { MembershipRole } from '../contracts.js';

/** Writes one membership's role, status and advanced role revision. */
export async function updateMembership(
  client: PoolClient,
  workspaceId: string,
  change: Readonly<{
    userId: string;
    role: MembershipRole;
    status: 'active' | 'suspended' | 'removed';
    roleRevision: number;
  }>,
): Promise<void> {
  await client.query(
    `update app.workspace_memberships
     set role=$3,status=$4,role_revision=$5,updated_at=clock_timestamp()
     where workspace_id=$1 and user_id=$2`,
    [
      workspaceId,
      change.userId,
      change.role,
      change.status,
      change.roleRevision,
    ],
  );
  // Favorites are private to a membership; a member who comes back starts
  // without them.
  if (change.status === 'removed') {
    await client.query('select app.clear_removed_member_notices($1,$2)', [
      workspaceId,
      change.userId,
    ]);
    await client.query(
      'delete from app.workflow_favorites where workspace_id=$1 and actor_id=$2',
      [workspaceId, change.userId],
    );
  }
}
