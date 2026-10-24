import { ADMINISTRATIVE_ROLES } from '@pertexo/workflow-model';
import type { AdministrativeRole } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { withWorkspaceScope } from '../../../tenant-access/transactions.js';
import { lockWorkspaceAuthority } from '../../../tenant-access/workspaces/authority.queries.js';
import { appendAuditFact } from '../../../governance/audit/events.repository.js';
import {
  FederationConflictError,
  type FederationScope,
  type OrganizationRow,
} from './contract.js';

export async function lockFederationWorkspace(
  client: PoolClient,
  scope: FederationScope,
  { ownerOnly }: Readonly<{ ownerOnly: boolean }>,
): Promise<AdministrativeRole> {
  await client.query('select id from app.workspaces where id=$1 for update', [
    scope.workspaceId,
  ]);
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
  return (
    await client.query<OrganizationRow>(
      `select organization.* from app.auth_organizations organization
    join app.auth_organization_workspaces link on link.organization_id=organization.id where link.workspace_id=$1 ${locking ? 'for update of organization' : ''}`,
      [workspaceId],
    )
  ).rows[0];
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
