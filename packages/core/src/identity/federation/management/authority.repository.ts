import {
  authOrganizationWorkspaces,
  authOrganizations,
} from '@pertexo/database/schema';
import { eq, getTableName } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  rethrowQueryFailure,
  setOrganizationContext,
  withWorkspaceScope,
} from '@pertexo/database/primitives';
import { appendAuditFact } from '../../../governance/audit/facts.js';
import { organizationRecords } from './identity-organizations.repository.js';
import {
  ADMINISTRATIVE_ROLES,
  BROWSABLE_WORKSPACE_STATUSES,
  rolesForCapability,
  type Role,
} from '@pertexo/policy';
import type { PoolClient } from 'pg';
import {
  lockWorkspaceAuthority,
  readWorkspaceAuthority,
  lockWorkspaceRow,
} from '../../../shared/authority.repository.js';
import { FederationConflictError } from './federation-management.errors.js';
import type { FederationScope } from './federation-management.types.js';
import type { OrganizationRow } from './identity-organizations.repository.js';

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
      await lockWorkspaceAuthority(
        scoped,
        scope.workspaceId,
        scope.actorId,
        ADMINISTRATIVE_ROLES,
      ),
      'change',
    );
  });
}
export async function organizationForWorkspace(
  client: PoolClient,
  workspaceId: string,
  { locking = false }: Readonly<{ locking?: boolean | undefined }> = {},
): Promise<OrganizationRow | undefined> {
  const query = organizationRecords(client)
    .innerJoin(
      authOrganizationWorkspaces,
      eq(authOrganizationWorkspaces.organizationId, authOrganizations.id),
    )
    .where(eq(authOrganizationWorkspaces.workspaceId, workspaceId));
  const [row] = await (
    locking ? query.for('update', { of: organizationLockTarget }) : query
  ).catch(rethrowQueryFailure);
  return row;
}
export async function recordFederationAudit(
  client: PoolClient,
  scope: FederationScope,
  {
    action,
    targetId,
    metadata = {},
  }: Readonly<{
    action: string;
    targetId: string;
    metadata?: Readonly<Record<string, string | number | boolean>> | undefined;
  }>,
): Promise<void> {
  await withWorkspaceScope(client, scope, (scoped) =>
    appendAuditFact(scoped, {
      workspaceId: scope.workspaceId,
      actorId: scope.actorId,
      action,
      targetType: 'identity_organization',
      targetId,
      metadata,
    }),
  );
}

const organizationLockTarget = alias(
  authOrganizations,
  getTableName(authOrganizations),
);

/** Internal discovery uses existing read authority; writers still recheck the owner under their original locks. */
export async function authorizeOrganizationContext(
  client: PoolClient,
  scope: FederationScope,
): Promise<OrganizationRow | undefined> {
  const organization = await withWorkspaceScope(
    client,
    scope,
    async (scoped) => {
      await readWorkspaceAuthority(scoped, scope.workspaceId, {
        actorId: scope.actorId,
        roles: rolesForCapability('member:read'),
        allowedStatuses: BROWSABLE_WORKSPACE_STATUSES,
      });
      return organizationForWorkspace(scoped, scope.workspaceId);
    },
  );
  if (organization !== undefined)
    await setOrganizationContext(client, organization.id);
  return organization;
}
