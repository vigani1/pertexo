import {
  users,
  workspaceMemberships,
  authDirectoryGroups,
  authDirectoryGroupMappings,
  authDirectoryUsers,
  authDirectoryMemberships,
} from '@pertexo/database/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  withWorkspaceScope,
} from '@pertexo/database/primitives';
import { readDirectoryRole } from '../roles.queries.js';
import type { Pool } from 'pg';
import { DirectoryError } from '../errors.js';
import { projectDirectoryMemberships } from '../projection.repository.js';
import {
  auditDirectoryManagement,
  runDirectoryCommand,
} from './commands.repository.js';
import type {
  AdoptMembershipInput,
  ReplaceMappingsInput,
} from '../contract.js';

export async function replaceDirectoryMappings(
  pool: Pool,
  input: ReplaceMappingsInput,
): Promise<void> {
  await runDirectoryCommand(pool, input, {
    operation: 'identity.directory.mappings.replace',
    request: {
      mappings: input.mappings,
      expectedRevision: input.expectedRevision,
    },
    change: async (client, organization) => {
      const workspaces = new Set(
        organization.workspaces.map((workspace) => workspace.workspace_id),
      );
      if (
        input.mappings.some((mapping) => !workspaces.has(mapping.workspaceId))
      )
        throw new DirectoryError('invalid_value');
      const groups = new Set(
        (
          await drizzle(client)
            .select({ id: authDirectoryGroups.id })
            .from(authDirectoryGroups)
            .where(eq(authDirectoryGroups.organizationId, organization.id))
            .catch(rethrowQueryFailure)
        ).map((group) => group.id),
      );
      if (input.mappings.some((mapping) => !groups.has(mapping.groupId)))
        throw new DirectoryError('invalid_value');
      await drizzle(client)
        .delete(authDirectoryGroupMappings)
        .where(eq(authDirectoryGroupMappings.organizationId, organization.id))
        .catch(rethrowQueryFailure);
      if (input.mappings.length > 0)
        await drizzle(client)
          .insert(authDirectoryGroupMappings)
          .values(
            input.mappings.map((mapping) => ({
              organizationId: organization.id,
              workspaceId: mapping.workspaceId,
              groupId: mapping.groupId,
              role: mapping.role,
              priority: mapping.priority,
            })),
          )
          .catch(rethrowQueryFailure);
      await projectDirectoryMemberships(client, organization, {
        actorId: input.actorId,
      });
      await auditDirectoryManagement(client, input, {
        organizationId: organization.id,
        action: 'identity.directory_mappings_changed',
        targetId: organization.id,
      });
      return { receipt: { organizationId: organization.id }, value: undefined };
    },
  });
}

export async function adoptDirectoryMembership(
  pool: Pool,
  input: AdoptMembershipInput,
): Promise<void> {
  await runDirectoryCommand(pool, input, {
    operation: 'identity.directory.membership.adopt',
    request: {
      workspaceId: input.targetWorkspaceId,
      directoryUserId: input.directoryUserId,
      directoryRevision: input.directoryRevision,
      membershipRevision: input.membershipRevision,
      role: input.role,
      expectedRevision: input.expectedRevision,
    },
    change: async (client, organization) => {
      const workspace = organization.workspaces.find(
        (entry) => entry.workspace_id === input.targetWorkspaceId,
      );
      if (workspace === undefined) throw new DirectoryError('invalid_value');
      const [user] = await drizzle(client)
        .select({
          user_id: authDirectoryUsers.userId,
          revision: authDirectoryUsers.revision,
        })
        .from(authDirectoryUsers)
        .where(
          and(
            eq(authDirectoryUsers.organizationId, organization.id),
            eq(authDirectoryUsers.id, input.directoryUserId),
            eq(authDirectoryUsers.active, true),
            isNull(authDirectoryUsers.deletedAt),
          ),
        )
        .catch(rethrowQueryFailure);
      if (user?.user_id === null || user === undefined)
        throw new DirectoryError('invalid_value');
      if (user.revision !== input.directoryRevision)
        throw new DirectoryError('stale');
      const userId = user.user_id;
      await drizzle(client)
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for('update')
        .catch(rethrowQueryFailure);
      const mapped = await readDirectoryRole(client, organization.id, {
        workspaceId: workspace.workspace_id,
        directoryUserId: input.directoryUserId,
        fallback: workspace.default_role,
      });
      if (mapped !== input.role) throw new DirectoryError('stale');
      await withWorkspaceScope(
        client,
        { workspaceId: workspace.workspace_id, actorId: input.actorId },
        async (scoped) => {
          const [member] = await drizzle(scoped)
            .select({
              role: workspaceMemberships.role,
              status: workspaceMemberships.status,
              role_revision: workspaceMemberships.roleRevision,
            })
            .from(workspaceMemberships)
            .where(
              and(
                eq(workspaceMemberships.workspaceId, workspace.workspace_id),
                eq(workspaceMemberships.userId, userId),
              ),
            )
            .for('update')
            .catch(rethrowQueryFailure);
          if (member?.role === 'owner')
            throw new DirectoryError('owner_protected');
          if (member?.status !== 'active')
            throw new DirectoryError('invalid_value');
          if (member.role_revision !== input.membershipRevision)
            throw new DirectoryError('stale');
          if (
            (
              await drizzle(scoped)
                .select({ one: sql`1` })
                .from(authDirectoryMemberships)
                .where(
                  and(
                    eq(
                      authDirectoryMemberships.workspaceId,
                      workspace.workspace_id,
                    ),
                    eq(authDirectoryMemberships.userId, userId),
                  ),
                )
                .catch(rethrowQueryFailure)
            ).length !== 0
          )
            throw new DirectoryError('invalid_value');
          await drizzle(scoped)
            .insert(authDirectoryMemberships)
            .values({
              organizationId: organization.id,
              workspaceId: workspace.workspace_id,
              userId,
              directoryUserId: input.directoryUserId,
            })
            .catch(rethrowQueryFailure);
        },
      );
      await projectDirectoryMemberships(
        client,
        organization,
        { actorId: input.actorId },
        [input.directoryUserId],
      );
      await auditDirectoryManagement(
        client,
        { ...input, workspaceId: workspace.workspace_id },
        {
          organizationId: organization.id,
          action: 'identity.directory_membership_adopted',
          targetId: input.directoryUserId,
        },
      );
      return { receipt: { organizationId: organization.id }, value: undefined };
    },
  });
}
