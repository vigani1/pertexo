import type { PoolClient } from 'pg';
import { withWorkspaceScope } from '../../../tenant-access/transactions.js';
import { lockWorkspaceAuthority } from '../../../tenant-access/workspaces/authority.js';
import { appendAuditFact } from '../../../governance/audit/append.js';
import {
  FederationConflictError,
  type FederationScope,
  type OrganizationRow,
} from './contract.js';

export async function lockFederationWorkspace(
  client: PoolClient,
  scope: FederationScope,
  ownerOnly: boolean,
): Promise<'owner' | 'admin'> {
  await client.query('select id from app.workspaces where id=$1 for update', [
    scope.workspaceId,
  ]);
  return withWorkspaceScope(client, scope, async (scoped) => {
    const role = await lockWorkspaceAuthority(
      scoped,
      scope.workspaceId,
      scope.actorId,
      ['owner', 'admin'],
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
  locking = false,
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
  action: string,
  targetId: string,
  metadata: Readonly<Record<string, string | number | boolean>> = {},
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
