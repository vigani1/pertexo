import { workspaces } from '../../../schema/foundation.js';
import {
  authOrganizationWorkspaces,
  authOrganizations,
} from '../../../schema/identity/federation/organizations.js';
import { eq, getTableName } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { organizationRecords } from './records.queries.js';
import { ADMINISTRATIVE_ROLES } from '@pertexo/workflow-model';
import type { AdministrativeRole } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { withWorkspaceScope } from '../../../tenant-access/transactions.js';
import { lockWorkspaceAuthority } from '../../../tenant-access/workspaces/authority.queries.js';
import { appendAuditFact } from '../../../governance/audit/events.repository.js';
import { FederationConflictError } from './errors.js';
import type { FederationScope } from './contract.js';
import type { OrganizationRow } from './records.queries.js';

export async function lockFederationWorkspace(
  client: PoolClient,
  scope: FederationScope,
  { ownerOnly }: Readonly<{ ownerOnly: boolean }>,
): Promise<AdministrativeRole> {
  await drizzle(client)
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, scope.workspaceId))
    .for('update')
    .catch(rethrowQueryFailure);
  return withWorkspaceScope(client, scope, async (scoped) => {
    const role = await lockWorkspaceAuthority(
      scoped,
      scope.workspaceId,
      scope.actorId,
      ADMINISTRATIVE_ROLES,
    );
    if (ownerOnly && role !== 'owner')
      throw new FederationConflictError(
        'owner_required',
        'Only the control workspace owner can change organization sign-in.',
      );
    return role === 'owner' ? 'owner' : 'admin';
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
