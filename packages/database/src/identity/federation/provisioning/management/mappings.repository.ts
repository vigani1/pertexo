import { readDirectoryRole } from '../roles.queries.js';
import type { Pool } from 'pg';
import type { DirectoryMappings, DirectoryAdopt } from '@pertexo/contracts';
import { withWorkspaceScope } from '../../../../tenant-access/transactions.js';
import { DirectoryError } from '../contract.js';
import { projectDirectoryMemberships } from '../projection.repository.js';
import {
  auditDirectoryManagement,
  runDirectoryCommand,
  type DirectoryCommand,
} from './commands.repository.js';

export async function replaceDirectoryMappings(
  pool: Pool,
  input: DirectoryCommand & DirectoryMappings,
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
          await client.query<{ id: string }>(
            'select id from app.auth_directory_groups where organization_id=$1',
            [organization.id],
          )
        ).rows.map((group) => group.id),
      );
      if (input.mappings.some((mapping) => !groups.has(mapping.groupId)))
        throw new DirectoryError('invalid_value');
      await client.query(
        'delete from app.auth_directory_group_mappings where organization_id=$1',
        [organization.id],
      );
      if (input.mappings.length > 0)
        await client.query(
          `insert into app.auth_directory_group_mappings(organization_id,workspace_id,group_id,role,priority)
      select $1,mapping.workspace_id,mapping.group_id,mapping.role,mapping.priority from jsonb_to_recordset($2::jsonb) mapping(workspace_id uuid,group_id uuid,role text,priority integer)`,
          [
            organization.id,
            JSON.stringify(
              input.mappings.map((mapping) => ({
                workspace_id: mapping.workspaceId,
                group_id: mapping.groupId,
                role: mapping.role,
                priority: mapping.priority,
              })),
            ),
          ],
        );
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
  input: DirectoryCommand & DirectoryAdopt,
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
      const user = (
        await client.query<{ user_id: string | null; revision: number }>(
          'select user_id,revision from app.auth_directory_users where organization_id=$1 and id=$2 and active and deleted_at is null',
          [organization.id, input.directoryUserId],
        )
      ).rows[0];
      if (user?.user_id === null || user === undefined)
        throw new DirectoryError('invalid_value');
      if (user.revision !== input.directoryRevision)
        throw new DirectoryError('stale');
      await client.query('select id from app.users where id=$1 for update', [
        user.user_id,
      ]);
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
          const member = (
            await scoped.query<{
              role: string;
              status: string;
              role_revision: number;
            }>(
              'select role,status,role_revision from app.workspace_memberships where workspace_id=$1 and user_id=$2 for update',
              [workspace.workspace_id, user.user_id],
            )
          ).rows[0];
          if (member?.role === 'owner')
            throw new DirectoryError('owner_protected');
          if (member?.status !== 'active')
            throw new DirectoryError('invalid_value');
          if (member.role_revision !== input.membershipRevision)
            throw new DirectoryError('stale');
          if (
            (
              await scoped.query(
                'select 1 from app.auth_directory_memberships where workspace_id=$1 and user_id=$2',
                [workspace.workspace_id, user.user_id],
              )
            ).rowCount !== 0
          )
            throw new DirectoryError('invalid_value');
          await scoped.query(
            'insert into app.auth_directory_memberships(organization_id,workspace_id,user_id,directory_user_id) values($1,$2,$3,$4)',
            [
              organization.id,
              workspace.workspace_id,
              user.user_id,
              input.directoryUserId,
            ],
          );
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
