import { workspaces } from '../../../schema/foundation.js';
import { authOrganizations } from '../../../schema/identity/federation/organizations.js';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { organizationSelection } from './records.queries.js';
import type { Pool, PoolClient } from 'pg';
import type { FederationSettings } from '@pertexo/contracts';
import {
  claimCommand,
  completeCommand,
} from '../../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import {
  withPlatformTransaction,
  withWorkspaceScope,
} from '../../../tenant-access/transactions.js';
import { FederationConflictError } from './errors.js';
import type { FederationScope } from './contract.js';
import type { OrganizationRow } from './records.queries.js';
import {
  lockFederationWorkspace,
  organizationForWorkspace,
} from './authority.repository.js';
import { projectOrganization } from './settings.queries.js';
import { lockDirectoryParticipants } from '../provisioning/authority.repository.js';
export async function requireControlOrganization(
  client: PoolClient,
  scope: FederationScope,
): Promise<OrganizationRow> {
  const organization = await organizationForWorkspace(
    client,
    scope.workspaceId,
    { locking: true },
  );
  if (organization?.control_workspace_id !== scope.workspaceId)
    throw new FederationConflictError(
      'owner_required',
      'Manage sign-in from the organization control workspace.',
    );
  return organization;
}
export function assertOrganizationRevision(
  organization: OrganizationRow,
  expectedRevision: number,
): void {
  if (organization.revision !== expectedRevision)
    throw new FederationConflictError(
      'stale',
      'Sign-in settings changed. Reload before saving.',
    );
}
export async function runFederationCommand(
  pool: Pool,
  input: FederationScope & Readonly<{ idempotencyKey: string }>,
  {
    operation,
    request,
    change,
    additionalWorkspaceIds = [],
  }: Readonly<{
    operation: string;
    request: unknown;
    change: (client: PoolClient) => Promise<OrganizationRow>;
    additionalWorkspaceIds?: readonly string[] | undefined;
  }>,
): Promise<FederationSettings> {
  return withPlatformTransaction(
    pool,
    async (client) => {
      const workspaceIds = [
        ...new Set([input.workspaceId, ...additionalWorkspaceIds]),
      ].sort();
      for (const workspaceId of workspaceIds)
        await drizzle(client)
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .for('update')
          .catch(rethrowQueryFailure);
      const organization = await organizationForWorkspace(
        client,
        input.workspaceId,
        { locking: true },
      );
      await lockDirectoryParticipants(client, organization?.id, input.actorId);
      for (const workspaceId of workspaceIds)
        await lockFederationWorkspace(
          client,
          { ...input, workspaceId },
          { ownerOnly: true },
        );
      const identity = {
        workspaceId: input.workspaceId,
        scope: input.actorId,
        operation,
        idempotencyKey: input.idempotencyKey,
      };
      const replay = await withWorkspaceScope(client, input, (scoped) =>
        claimCommand<FederationSettings>(scoped, {
          ...identity,
          resourceId: generatePersistedId(),
          request,
        }),
      );
      if (replay !== null) return replay;
      const changedOrganization = await change(client);
      const result: FederationSettings = {
        configured: true,
        reason: null,
        canManage: true,
        organization: await projectOrganization(client, changedOrganization),
      };
      await withWorkspaceScope(client, input, (scoped) =>
        completeCommand(scoped, identity, result),
      );
      return result;
    },
    input.signal === undefined ? {} : { signal: input.signal },
  );
}
export async function advanceOrganization(
  client: PoolClient,
  organization: OrganizationRow,
): Promise<OrganizationRow> {
  const [row] = await drizzle(client)
    .update(authOrganizations)
    .set({ revision: sql`${authOrganizations.revision}+1` })
    .where(eq(authOrganizations.id, organization.id))
    .returning(organizationSelection)
    .catch(rethrowQueryFailure);
  if (row === undefined) throw new Error('Organization disappeared under lock');
  return row;
}
