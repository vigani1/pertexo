import {
  authOrganizations,
  authOrganizationWorkspaces,
  authDomains,
  authProviders,
} from '@pertexo/database/schema';
import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { organizationSelection } from './records.queries.js';
import { FEDERATION_LIMITS } from '@pertexo/workflow-model';
import type { DelegatedRole } from '@pertexo/workflow-model';
import { projectDirectoryMemberships } from '../provisioning/projection.repository.js';
import type { Pool, PoolClient } from 'pg';
import type { FederationSettings } from '@pertexo/contracts';
import { generatePersistedId } from '@pertexo/database/platform';
import { FederationConflictError } from './errors.js';
import type { FederationScope } from './contract.js';
import {
  organizationForWorkspace,
  recordFederationAudit,
} from './authority.repository.js';
import {
  advanceOrganization,
  assertOrganizationRevision,
  requireControlOrganization,
  runFederationCommand,
} from './commands.repository.js';
import type { FederationCommand } from './contract.js';

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
      const [row] = await drizzle(client)
        .insert(authOrganizations)
        .values({ id, controlWorkspaceId: input.workspaceId, name: input.name })
        .returning(organizationSelection)
        .catch(rethrowQueryFailure);
      if (row === undefined)
        throw new Error('Organization creation returned no row');
      await drizzle(client)
        .insert(authOrganizationWorkspaces)
        .values({ workspaceId: input.workspaceId, organizationId: id })
        .catch(rethrowQueryFailure);
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
        const [row] = await drizzle(client)
          .select({ count: count() })
          .from(authOrganizationWorkspaces)
          .where(eq(authOrganizationWorkspaces.organizationId, organization.id))
          .catch(rethrowQueryFailure);
        const total = row?.count ?? 0;
        if (total >= FEDERATION_LIMITS.workspaces)
          throw new FederationConflictError(
            'limit',
            'The organization workspace limit has been reached.',
          );
      }
      await drizzle(client)
        .insert(authOrganizationWorkspaces)
        .values({
          workspaceId: input.targetWorkspaceId,
          organizationId: organization.id,
          defaultRole: input.defaultRole,
        })
        .onConflictDoUpdate({
          target: authOrganizationWorkspaces.workspaceId,
          set: { defaultRole: input.defaultRole },
        })
        .catch(rethrowQueryFailure);
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
  const table = resource === 'domains' ? authDomains : authProviders;
  const [row] = await drizzle(client)
    .select({ count: count() })
    .from(table)
    .where(eq(table.organizationId, organizationId))
    .catch(rethrowQueryFailure);
  const total = row?.count ?? 0;
  if (total >= FEDERATION_LIMITS[resource])
    throw new FederationConflictError(
      'limit',
      `The organization ${resource} limit has been reached.`,
    );
}
