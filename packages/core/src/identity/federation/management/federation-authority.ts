import { authorizeOrganizationContext } from './authorize-organization.js';
import { requireWorkspaceAuthority } from '../../../shared/access/workspace-access.errors.js';
import { claimCommand, completeCommand } from '@pertexo/database/primitives';

import type { Pool } from 'pg';

import type { FederationSettings } from '@pertexo/contracts';

import {
  generatePersistedId,
  withPlatformTransaction,
} from '@pertexo/database/platform';

import { projectOrganization } from './settings.repository.js';

import { lockDirectoryParticipants } from '../provisioning/authority.repository.js';

import {
  setOrganizationContext,
  withWorkspaceScope,
} from '@pertexo/database/primitives';
import { ADMINISTRATIVE_ROLES, type Role } from '@pertexo/policy';
import type { PoolClient } from 'pg';

import { lockWorkspaceRow } from '../../../shared/access/authority.repository.js';

import { lockWorkspaceAuthority } from '../../../shared/access/workspace-authority.js';
import { FederationConflictError } from './federation-management.errors.js';

import type { FederationScope } from './federation-management.types.js';

import type { OrganizationRow } from './identity-organizations.repository.js';

import { organizationForWorkspace } from './authority.repository.js';

export function requireFederationOwner(
  role: Role,
  action: 'manage' | 'change',
): void {
  if (role !== 'owner')
    throw new FederationConflictError(
      'owner_required',
      `Only the control workspace owner can ${action} organization sign-in.`,
    );
}

/** Takes the row first, as `withWorkspaceAccess` would, for flows that can't sit on it. */
export async function lockFederationWorkspace(
  client: PoolClient,
  scope: FederationScope,
): Promise<void> {
  await lockWorkspaceRow(client, scope.workspaceId);
  await withWorkspaceScope(client, scope, async (scoped) => {
    requireFederationOwner(
      requireWorkspaceAuthority(
        await lockWorkspaceAuthority(
          scoped,
          scope.workspaceId,
          scope.actorId,
          ADMINISTRATIVE_ROLES,
        ),
      ),
      'change',
    );
  });
}

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

/**
 * Doesn't fit `withWorkspaceAccess`. A command can span two workspaces, and it
 * locks the organization and every bound user before authority: a directory
 * fan-out locks users in id order, so a share lock on the actor taken first
 * could deadlock against it. Its audit facts also install their own scopes,
 * and a scope can't be installed inside the helper's.
 */
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
        await lockWorkspaceRow(client, workspaceId);
      await authorizeOrganizationContext(client, input);
      const organization = await organizationForWorkspace(
        client,
        input.workspaceId,
        { locking: true },
      );
      await lockDirectoryParticipants(client, organization?.id, input.actorId);
      for (const workspaceId of workspaceIds)
        await lockFederationWorkspace(client, { ...input, workspaceId });
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
      await setOrganizationContext(client, changedOrganization.id);
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
