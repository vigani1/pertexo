import {
  loadDirectoryProjection,
  loadWorkspaceProjection,
} from './projection.queries.js';
import { authDirectoryMemberships } from '@pertexo/database/schema';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';

import {
  rethrowQueryFailure,
  appendAuditFacts,
  type AuditFact,
  withWorkspaceScope,
} from '@pertexo/database/primitives';

import type { PoolClient } from 'pg';
import {
  createMemberships,
  updateMemberships,
} from '../../../tenant-access/members/records.repository.js';
import type {
  MembershipChange,
  MembershipAddition,
} from '../../../tenant-access/members/contract.js';

import { revokeSessionsForUsers } from '../../../tenant-access/users/sessions.repository.js';
import type { DirectoryOrganization } from './contract.js';

import { projectMember } from './projection.js';
import { directoryRole } from './roles.js';

/** The caller holds all linked workspace locks and the organization lock. */
export async function projectDirectoryMemberships(
  client: PoolClient,
  organization: DirectoryOrganization,
  actor: Readonly<{ actorId?: string; credentialId?: string }> = {},
  directoryUserIds?: readonly string[],
): Promise<void> {
  const projection = await loadDirectoryProjection(
    client,
    organization.id,
    directoryUserIds,
  );
  if (projection === undefined) return;
  const { users, userIds, groupRoles, groupsByUser } = projection;
  const revoked = new Set<string>();
  for (const workspace of organization.workspaces)
    await withWorkspaceScope(
      client,
      { workspaceId: workspace.workspace_id },
      async (scoped) => {
        const { active, members } = await loadWorkspaceProjection(scoped, {
          workspaceId: workspace.workspace_id,
          userIds,
        });
        const mappings = groupRoles.filter(
          (mapping) => mapping.workspaceId === workspace.workspace_id,
        );
        const changes: MembershipChange[] = [],
          additions: Extract<MembershipAddition, { source: 'directory' }>[] =
            [],
          facts: AuditFact[] = [];
        for (const user of users) {
          const role = directoryRole(
            mappings,
            groupsByUser.get(user.id) ?? new Set<string>(),
            workspace.default_role,
          );
          const projected = projectMember({
            member: members.get(user.user_id),
            user,
            workspaceActive: active,
            role,
          });
          if (projected.kind === 'leave') continue;
          if (projected.kind === 'add') {
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
          const { status, roleRevision } = projected;
          changes.push({ userId: user.user_id, role, status, roleRevision });
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
          const source = drizzle(scoped)
            .select({
              organizationId: sql<string>`${organization.id}::uuid`.as(
                'organization_id',
              ),
              workspaceId: sql<string>`${workspace.workspace_id}::uuid`.as(
                'workspace_id',
              ),
              userId: sql<string>`member.user_id`.as('user_id'),
              directoryUserId: sql<string>`member.directory_id`.as(
                'directory_user_id',
              ),
              createdAt: sql<Date>`clock_timestamp()`.as('created_at'),
            })
            .from(
              sql`unnest(${sql.param(additions.map((member) => member.userId))}::uuid[],${sql.param(additions.map((member) => member.directoryUserId))}::uuid[]) as member(user_id,directory_id)`,
            );
          await drizzle(scoped)
            .insert(authDirectoryMemberships)
            .select(source)
            .catch(rethrowQueryFailure);
        }
        await updateMemberships(scoped, workspace.workspace_id, changes);
        await appendAuditFacts(scoped, facts);
      },
    );
  await revokeSessionsForUsers(client, [...revoked]);
}
