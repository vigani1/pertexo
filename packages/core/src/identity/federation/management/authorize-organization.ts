import type { PoolClient } from 'pg';
import {
  setOrganizationContext,
  withWorkspaceScope,
} from '@pertexo/database/primitives';
import {
  BROWSABLE_WORKSPACE_STATUSES,
  rolesForCapability,
} from '@pertexo/policy';
import { requireWorkspaceAuthority } from '../../../shared/access/workspace-access.errors.js';
import { readWorkspaceAuthority } from '../../../shared/access/workspace-authority.js';
import { organizationForWorkspace } from './authority.repository.js';
import type { OrganizationRow } from './identity-organizations.repository.js';
import type { FederationScope } from './federation-management.types.js';

/** Internal discovery uses existing read authority; writers still recheck the owner under their original locks. */
export async function authorizeOrganizationContext(
  client: PoolClient,
  scope: FederationScope,
): Promise<OrganizationRow | undefined> {
  const organization = await withWorkspaceScope(
    client,
    scope,
    async (scoped) => {
      requireWorkspaceAuthority(
        await readWorkspaceAuthority(scoped, scope.workspaceId, {
          actorId: scope.actorId,
          roles: rolesForCapability('member:read'),
          allowedStatuses: BROWSABLE_WORKSPACE_STATUSES,
        }),
      );
      return organizationForWorkspace(scoped, scope.workspaceId);
    },
  );
  if (organization !== undefined)
    await setOrganizationContext(client, organization.id);
  return organization;
}
