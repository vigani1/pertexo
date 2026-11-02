import type { ApiTokenScope } from '@pertexo/contracts';
import {
  ACTIVE_WORKSPACE_STATUSES,
  API_TOKEN_SCOPES,
  hasCapability,
  UNPURGED_WORKSPACE_STATUSES,
  type Role,
} from '@pertexo/workflow-model';

/**
 * An owner can list and revoke tokens until the purge starts, so a suspended or
 * scheduled workspace can still shut its tokens off. Creating one needs an active one.
 */
export function tokenOwnerMayAct(
  mode: 'read' | 'create' | 'revoke',
  facts: Readonly<{
    workspaceStatus: string | undefined;
    userStatus: string | undefined;
    membershipStatus: string | undefined;
  }>,
): boolean {
  const statuses: readonly (string | undefined)[] =
    mode === 'create' ? ACTIVE_WORKSPACE_STATUSES : UNPURGED_WORKSPACE_STATUSES;
  return (
    statuses.includes(facts.workspaceStatus) &&
    facts.userStatus === 'active' &&
    facts.membershipStatus === 'active'
  );
}

export function availableApiTokenScopes(role: Role): ApiTokenScope[] {
  return API_TOKEN_SCOPES.filter((scope) => hasCapability(role, scope));
}
