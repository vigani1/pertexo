import { withWorkspaceScope } from '@pertexo/database/primitives';
import { FEDERATION_LIMITS } from '@pertexo/workflow-model';
import { projectDirectoryMemberships } from '../provisioning/projection.repository.js';
import type { Pool, PoolClient } from 'pg';
import type { FederationSettings } from '@pertexo/contracts';
import { generatePersistedId } from '@pertexo/database/platform';
import { FederationConflictError } from './federation-management.errors.js';
import {
  organizationForWorkspace,
  recordFederationAudit,
} from './authority.repository.js';
import { advanceOrganization } from './commands.repository.js';
import {
  assertOrganizationRevision,
  requireControlOrganization,
  runFederationCommand,
} from './federation-authority.js';
import type {
  CreateOrganizationInput,
  LinkWorkspaceInput,
} from './federation-management.types.js';
import {
  countOrganizationResources,
  countOrganizationWorkspaces,
  insertOrganization,
  linkWorkspace,
} from './organizations.repository.js';

export function createOrganization(
  pool: Pool,
  input: CreateOrganizationInput,
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
      const row = await insertOrganization(client, input, {
        id,
        name: input.name,
      });
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
  input: LinkWorkspaceInput,
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
      const existing = await withWorkspaceScope(
        client,
        { workspaceId: input.targetWorkspaceId },
        (scoped) => organizationForWorkspace(scoped, input.targetWorkspaceId),
      );
      if (existing !== undefined && existing.id !== organization.id)
        throw new FederationConflictError(
          'unavailable',
          'That workspace already belongs to another identity organization.',
        );
      if (existing === undefined) {
        const total = await countOrganizationWorkspaces(
          client,
          organization.id,
        );
        if (total >= FEDERATION_LIMITS.workspaces)
          throw new FederationConflictError(
            'limit',
            'The organization workspace limit has been reached.',
          );
      }
      await linkWorkspace(client, {
        workspaceId: input.targetWorkspaceId,
        organizationId: organization.id,
        defaultRole: input.defaultRole,
      });
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
  const total = await countOrganizationResources(
    client,
    organizationId,
    resource,
  );
  if (total >= FEDERATION_LIMITS[resource])
    throw new FederationConflictError(
      'limit',
      `The organization ${resource} limit has been reached.`,
    );
}
