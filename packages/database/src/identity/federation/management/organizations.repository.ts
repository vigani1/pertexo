import { FEDERATION_LIMITS } from '@pertexo/workflow-model';
import type { DelegatedRole } from '@pertexo/workflow-model';
import { projectDirectoryMemberships } from '../provisioning/projection.repository.js';
import type { Pool, PoolClient } from 'pg';
import type { FederationSettings } from '@pertexo/contracts';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import {
  FederationConflictError,
  type FederationScope,
  type OrganizationRow,
} from './contract.js';
import {
  organizationForWorkspace,
  recordFederationAudit,
} from './authority.repository.js';
import {
  advanceOrganization,
  assertOrganizationRevision,
  requireControlOrganization,
  runFederationCommand,
  type FederationCommand,
} from './commands.repository.js';

export function createOrganization(
  pool: Pool,
  input: FederationScope & Readonly<{ name: string; idempotencyKey: string }>,
): Promise<FederationSettings> {
  return runFederationCommand(pool, input, {
    operation: 'identity.organization.create',
    request: { name: input.name },
    change: async (client) => {
      if (
        (await organizationForWorkspace(client, input.workspaceId)) !==
        undefined
      )
        throw new FederationConflictError(
          'unavailable',
          'This workspace already belongs to an identity organization.',
        );
      const id = generatePersistedId();
      const row = (
        await client.query<OrganizationRow>(
          'insert into app.auth_organizations(id,control_workspace_id,name) values($1,$2,$3) returning *',
          [id, input.workspaceId, input.name],
        )
      ).rows[0];
      if (row === undefined)
        throw new Error('Organization creation returned no row');
      await client.query(
        'insert into app.auth_organization_workspaces(workspace_id,organization_id) values($1,$2)',
        [input.workspaceId, id],
      );
      await recordFederationAudit(client, input, {
        action: 'identity.organization_created',
        targetId: id,
      });
      return row;
    },
  });
}
export function linkOrganizationWorkspace(
  pool: Pool,
  input: FederationCommand &
    Readonly<{
      targetWorkspaceId: string;
      defaultRole: DelegatedRole;
    }>,
): Promise<FederationSettings> {
  return runFederationCommand(pool, input, {
    operation: 'identity.organization.link.workspace',
    request: {
      workspaceId: input.targetWorkspaceId,
      defaultRole: input.defaultRole,
      expectedRevision: input.expectedRevision,
    },
    change: async (client) => {
      const organization = await requireControlOrganization(client, input);
      assertOrganizationRevision(organization, input.expectedRevision);
      const existing = await organizationForWorkspace(
        client,
        input.targetWorkspaceId,
      );
      if (existing !== undefined && existing.id !== organization.id)
        throw new FederationConflictError(
          'unavailable',
          'That workspace already belongs to another identity organization.',
        );
      if (existing === undefined) {
        const count =
          (
            await client.query<{ count: number }>(
              'select count(*)::integer as count from app.auth_organization_workspaces where organization_id=$1',
              [organization.id],
            )
          ).rows[0]?.count ?? 0;
        if (count >= FEDERATION_LIMITS.workspaces)
          throw new FederationConflictError(
            'limit',
            'The organization workspace limit has been reached.',
          );
      }
      await client.query(
        'insert into app.auth_organization_workspaces(workspace_id,organization_id,default_role) values($1,$2,$3) on conflict(workspace_id) do update set default_role=excluded.default_role',
        [input.targetWorkspaceId, organization.id, input.defaultRole],
      );
      await projectDirectoryMemberships(
        client,
        {
          ...organization,
          workspaces: [
            {
              workspace_id: input.targetWorkspaceId,
              default_role: input.defaultRole,
            },
          ],
        },
        { actorId: input.actorId },
      );
      await recordFederationAudit(client, input, {
        action: 'identity.workspace_linked',
        targetId: organization.id,
        metadata: {
          workspaceId: input.targetWorkspaceId,
          defaultRole: input.defaultRole,
        },
      });
      if (input.targetWorkspaceId !== input.workspaceId)
        await recordFederationAudit(
          client,
          { ...input, workspaceId: input.targetWorkspaceId },
          {
            action: 'identity.workspace_linked',
            targetId: organization.id,
            metadata: {
              controlWorkspaceId: input.workspaceId,
              defaultRole: input.defaultRole,
            },
          },
        );
      return advanceOrganization(client, organization);
    },
    additionalWorkspaceIds: [input.targetWorkspaceId],
  });
}
export async function requireResourceCapacity(
  client: PoolClient,
  organizationId: string,
  resource: 'domains' | 'providers',
): Promise<void> {
  const table =
    resource === 'domains' ? 'app.auth_domains' : 'app.auth_providers';
  const count =
    (
      await client.query<{ count: number }>(
        `select count(*)::integer as count from ${table} where organization_id=$1`,
        [organizationId],
      )
    ).rows[0]?.count ?? 0;
  if (count >= FEDERATION_LIMITS[resource])
    throw new FederationConflictError(
      'limit',
      `The organization ${resource} limit has been reached.`,
    );
}
