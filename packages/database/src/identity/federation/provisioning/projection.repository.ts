import type { Role } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import {
  appendAuditFacts,
  type AuditFact,
} from '../../../governance/audit/events.repository.js';
import {
  createMemberships,
  updateMemberships,
} from '../../../tenant-access/members/records.repository.js';
import type {
  MembershipChange,
  MembershipAddition,
} from '../../../tenant-access/members/contract.js';

import { withWorkspaceScope } from '../../../tenant-access/transactions.js';
import { revokeSessionsForUsers } from '../../../tenant-access/users/sessions.repository.js';
import type { DirectoryOrganization } from './authority.repository.js';
import type { DirectoryMapping } from './contract.js';
import { directoryRole } from './roles.queries.js';

type BoundUser = Readonly<{
  id: string;
  user_id: string;
  active: boolean;
  deleted_at: Date | null;
}>;
type ExistingMember = Readonly<{
  user_id: string;
  role: Role;
  status: 'active' | 'suspended' | 'removed';
  role_revision: number;
  directory_user_id: string | null;
}>;
/** The caller holds all linked workspace locks and the organization lock. */
export async function projectDirectoryMemberships(
  client: PoolClient,
  organization: DirectoryOrganization,
  actor: Readonly<{ actorId?: string; credentialId?: string }> = {},
  directoryUserIds?: readonly string[],
): Promise<void> {
  const users = (
    await client.query<BoundUser>(
      `select id,user_id,active,deleted_at from app.auth_directory_users
     where organization_id=$1 and user_id is not null and ($2::uuid[] is null or id=any($2::uuid[])) order by user_id`,
      [organization.id, directoryUserIds ?? null],
    )
  ).rows;
  if (users.length === 0) return;
  const userIds = users.map((user) => user.user_id);
  await client.query(
    'select id from app.users where id=any($1::uuid[]) order by id for update',
    [userIds],
  );
  const groupRoles = (
    await client.query<DirectoryMapping>(
      'select workspace_id "workspaceId",group_id "groupId",role,priority from app.auth_directory_group_mappings where organization_id=$1 order by workspace_id,priority',
      [organization.id],
    )
  ).rows;
  const groupMembers = (
    await client.query<{ group_id: string; directory_user_id: string }>(
      'select group_id,directory_user_id from app.auth_directory_group_members where organization_id=$1 and directory_user_id=any($2::uuid[])',
      [organization.id, users.map((user) => user.id)],
    )
  ).rows;
  const groupsByUser = new Map<string, Set<string>>();
  for (const member of groupMembers) {
    const groups =
      groupsByUser.get(member.directory_user_id) ?? new Set<string>();
    groups.add(member.group_id);
    groupsByUser.set(member.directory_user_id, groups);
  }
  const revoked = new Set<string>();
  for (const workspace of organization.workspaces)
    await withWorkspaceScope(
      client,
      { workspaceId: workspace.workspace_id },
      async (scoped) => {
        const active =
          (
            await scoped.query<{ status: string }>(
              'select status from app.workspaces where id=$1',
              [workspace.workspace_id],
            )
          ).rows[0]?.status === 'active';
        const members = new Map(
          (
            await scoped.query<ExistingMember>(
              `select member.user_id,member.role,member.status,member.role_revision,source.directory_user_id
       from app.workspace_memberships member
       left join app.auth_directory_memberships source on source.workspace_id=member.workspace_id and source.user_id=member.user_id
       where member.workspace_id=$1 and member.user_id=any($2::uuid[]) order by member.user_id for update of member`,
              [workspace.workspace_id, userIds],
            )
          ).rows.map((member) => [member.user_id, member]),
        );
        const mappings = groupRoles.filter(
          (mapping) => mapping.workspaceId === workspace.workspace_id,
        );
        const changes: MembershipChange[] = [],
          additions: Extract<MembershipAddition, { source: 'directory' }>[] =
            [],
          facts: AuditFact[] = [];
        for (const user of users) {
          const member = members.get(user.user_id);
          // Manual grants, including removed ones, are never adopted implicitly.
          const membershipNotManaged =
            member !== undefined &&
            (member.directory_user_id !== user.id || member.role === 'owner');
          if (membershipNotManaged) continue;
          const membershipActive =
            active && user.active && user.deleted_at === null;
          const status = membershipActive ? 'active' : 'removed';
          const role = directoryRole(
            mappings,
            groupsByUser.get(user.id) ?? new Set<string>(),
            workspace.default_role,
          );
          if (member === undefined) {
            if (status !== 'active') continue;
            additions.push({
              userId: user.user_id,
              directoryUserId: user.id,
              source: 'directory',
              organizationId: organization.id,
              ...(actor.credentialId === undefined
                ? {}
                : { credentialId: actor.credentialId }),
              role,
            });
            continue;
          }
          if (member.role === role && member.status === status) continue;
          changes.push({
            userId: user.user_id,
            role,
            status,
            roleRevision: member.role_revision + 1,
          });
          revoked.add(user.user_id);
          facts.push({
            workspaceId: workspace.workspace_id,
            actorId: actor.actorId ?? null,
            action: 'identity.membership_projected',
            targetType: 'workspace_member',
            targetId: user.user_id,
            metadata: {
              organizationId: organization.id,
              directoryUserId: user.id,
              source: 'directory',
              role,
              status,
              ...(actor.credentialId === undefined
                ? {}
                : { credentialId: actor.credentialId }),
            },
          });
        }
        if (additions.length > 0) {
          await createMemberships(scoped, workspace.workspace_id, additions, {
            actorId: actor.actorId ?? null,
          });
          await scoped.query(
            `insert into app.auth_directory_memberships(organization_id,workspace_id,user_id,directory_user_id)
        select $1,$2,member.user_id,member.directory_id from unnest($3::uuid[],$4::uuid[]) as member(user_id,directory_id)`,
            [
              organization.id,
              workspace.workspace_id,
              additions.map((member) => member.userId),
              additions.map((member) => member.directoryUserId),
            ],
          );
        }
        await updateMemberships(scoped, workspace.workspace_id, changes);
        await appendAuditFacts(scoped, facts);
      },
    );
  await revokeSessionsForUsers(client, [...revoked]);
}
