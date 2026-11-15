import { withWorkspaceScope } from '@pertexo/database/primitives';
import { readDirectoryRole } from '../roles.repository.js';
import { readAdoptableDirectoryUser } from './adoption.repository.js';
import type { Pool } from 'pg';
import { DirectoryError } from '../directory.errors.js';
import { projectDirectoryMemberships } from '../projection.repository.js';
import {
  auditDirectoryManagement,
  runDirectoryCommand,
} from './directory-commands.js';
import type {
  AdoptMembershipInput,
  ReplaceMappingsInput,
} from '../directory-provisioning.types.js';

import {
  directoryManagesMembership,
  insertDirectoryMembership,
  lockMembership,
  lockUser,
  readDirectoryGroupIds,
  replaceMappings,
} from './mappings.repository.js';

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
        await readDirectoryGroupIds(client, organization.id),
      );
      if (input.mappings.some((mapping) => !groups.has(mapping.groupId)))
        throw new DirectoryError('invalid_value');
      await replaceMappings(client, organization.id, input.mappings);
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
      const user = await readAdoptableDirectoryUser(
        client,
        organization.id,
        input.directoryUserId,
      );
      if (user?.user_id === null || user === undefined)
        throw new DirectoryError('invalid_value');
      if (user.revision !== input.directoryRevision)
        throw new DirectoryError('stale');
      const userId = user.user_id;
      await lockUser(client, userId);
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
          const member = await lockMembership(
            scoped,
            workspace.workspace_id,
            userId,
          );
          if (member?.role === 'owner')
            throw new DirectoryError('owner_protected');
          if (member?.status !== 'active')
            throw new DirectoryError('invalid_value');
          if (member.role_revision !== input.membershipRevision)
            throw new DirectoryError('stale');
          if (
            await directoryManagesMembership(
              scoped,
              workspace.workspace_id,
              userId,
            )
          )
            throw new DirectoryError('invalid_value');
          await insertDirectoryMembership(scoped, {
            organizationId: organization.id,
            workspaceId: workspace.workspace_id,
            userId,
            directoryUserId: input.directoryUserId,
          });
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
