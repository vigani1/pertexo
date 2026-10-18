import type { PoolClient } from 'pg';
import type { MembershipRole } from '../contracts.js';

export type MembershipAddition = Readonly<{
  userId: string;
  role: MembershipRole;
}>;

export async function createMemberships(
  client: PoolClient,
  workspaceId: string,
  additions: readonly MembershipAddition[],
): Promise<void> {
  await client.query(
    `insert into app.workspace_memberships(workspace_id,user_id,role,status)
        select $1,member.user_id,member.role,'active' from unnest($2::uuid[],$3::text[]) as member(user_id,role)`,
    [
      workspaceId,
      additions.map((member) => member.userId),
      additions.map((member) => member.role),
    ],
  );
}

export type MembershipChange = Readonly<{
  userId: string;
  role: MembershipRole;
  status: 'active' | 'suspended' | 'removed';
  roleRevision: number;
}>;

/** The caller owns unique member IDs and revisions; removal keeps private cleanup atomic. */
export async function updateMemberships(
  client: PoolClient,
  workspaceId: string,
  changes: readonly MembershipChange[],
): Promise<void> {
  if (changes.length === 0) return;
  await client.query(
    `update app.workspace_memberships member
     set role=change.role,status=change.status,role_revision=change.revision,
         updated_at=clock_timestamp()
     from unnest($2::uuid[],$3::text[],$4::text[],$5::integer[])
       as change(user_id,role,status,revision)
     where member.workspace_id=$1 and member.user_id=change.user_id`,
    [
      workspaceId,
      changes.map((change) => change.userId),
      changes.map((change) => change.role),
      changes.map((change) => change.status),
      changes.map((change) => change.roleRevision),
    ],
  );
  const removed = changes
    .filter((change) => change.status === 'removed')
    .map((change) => change.userId);
  if (removed.length === 0) return;
  await client.query(
    `select app.clear_removed_member_notices($1,removed.user_id)
     from unnest($2::uuid[]) as removed(user_id)`,
    [workspaceId, removed],
  );
  await client.query(
    'delete from app.workflow_favorites where workspace_id=$1 and actor_id=any($2::uuid[])',
    [workspaceId, removed],
  );
}
export function updateMembership(
  client: PoolClient,
  workspaceId: string,
  change: MembershipChange,
): Promise<void> {
  return updateMemberships(client, workspaceId, [change]);
}
