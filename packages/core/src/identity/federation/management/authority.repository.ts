import {
  authOrganizationWorkspaces,
  authOrganizations,
} from '@pertexo/database/schema';
import { eq, getTableName } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  rethrowQueryFailure,
  withWorkspaceScope,
  appendAuditFact,
} from '@pertexo/database/primitives';
import { organizationRecords } from './records.queries.js';
import { ADMINISTRATIVE_ROLES, type Role } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import {
  lockWorkspaceAuthority,
  lockWorkspaceRow,
} from '../../../shared/authority.queries.js';
import { FederationConflictError } from './errors.js';
import type { FederationScope } from './contract.js';
import type { OrganizationRow } from './records.queries.js';

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
