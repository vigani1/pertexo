import type { PoolClient } from 'pg';
import { withActorDiscoveryScope } from '../../../tenant-access/transactions.js';
/** The existing discovery fence reads this user's ownership, never another workspace's members. */
export async function isProtectedRecoveryOwner(
  client: PoolClient,
  userId: string,
): Promise<boolean> {
  return withActorDiscoveryScope(
    client,
    userId,
    async (scoped) =>
      (
        await scoped.query(
          `select 1 from app.workspace_memberships membership join app.auth_organizations organization on organization.control_workspace_id=membership.workspace_id
 where membership.user_id=$1 and membership.role='owner' and membership.status='active' and exists(select 1 from app.auth_domains domain where domain.organization_id=organization.id and domain.require_sso) limit 1`,
          [userId],
        )
      ).rowCount === 1,
  );
}
/** Called under the normal workspace/user locks before transferring recovery authority. */
export async function canTransferRecoveryOwnership(
  client: PoolClient,
  workspaceId: string,
  targetUserId: string,
): Promise<boolean> {
  const required =
    (
      await client.query(
        `select 1 from app.auth_organizations organization join app.auth_domains domain on domain.organization_id=organization.id and domain.require_sso where organization.control_workspace_id=$1 limit 1`,
        [workspaceId],
      )
    ).rowCount === 1;
  if (!required) return true;
  return (
    (
      await client.query(
        `select 1 from app.users users join app.auth_accounts account on account.user_id=users.id and account.provider_id='credential'
 where users.id=$1 and users.status='active' and users.email_verified and account.password is not null and length(account.password)>0`,
        [targetUserId],
      )
    ).rowCount === 1
  );
}
