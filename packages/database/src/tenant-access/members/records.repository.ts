import type { Role } from '@pertexo/workflow-model';
import { removeMemberResourceGrants } from '../resources/revocation.repository.js';
import type { PoolClient } from 'pg';

import { appendAuditFacts } from '../../governance/audit/events.repository.js';

export type MembershipAddition = Readonly<
  { userId: string; role: Role } & (
    | { source: 'workspace_creation' }
    | { source: 'invitation'; invitationId: string }
    | { source: 'jit'; organizationId: string }
    | {
        source: 'directory';
        organizationId: string;
        directoryUserId: string;
        credentialId?: string;
      }
  )
>;

type MembershipCreationAudit = Readonly<{
  actorId: string | null;
  requestId?: string | null;
  traceId?: string | null;
}>;

/** The caller owns admission and locks; insertion and its fact share that transaction. */
export async function createMemberships(
  client: PoolClient,
  workspaceId: string,
  additions: readonly MembershipAddition[],
  audit: MembershipCreationAudit,
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
  await appendAuditFacts(
    client,
    additions.map((member) => ({
      workspaceId,
      actorId: audit.actorId,
      requestId: audit.requestId ?? null,
      traceId: audit.traceId ?? null,
      action: 'workspace.member_added',
      targetType: 'workspace_member',
      targetId: member.userId,
      metadata: {
        role: member.role,
        source: member.source,
        status: 'active',
        roleRevision: 1,
        ...(member.source === 'invitation'
          ? { invitationId: member.invitationId }
          : {}),
        ...(member.source === 'jit' || member.source === 'directory'
          ? { organizationId: member.organizationId }
          : {}),
        ...(member.source === 'directory'
          ? {
              directoryUserId: member.directoryUserId,
              ...(member.credentialId === undefined
                ? {}
                : { credentialId: member.credentialId }),
            }
          : {}),
      },
    })),
  );
}

export type MembershipChange = Readonly<{
  userId: string;
  role: Role;
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
  // Private notice rows remain actor-fenced. This narrow storage bridge checks
  // removal and workspace scope instead of granting cross-user read/delete access.
  await client.query(
    `select app.clear_removed_member_notices($1,removed.user_id)
     from unnest($2::uuid[]) as removed(user_id)`,
    [workspaceId, removed],
  );
  await removeMemberResourceGrants(client, workspaceId, removed);
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
