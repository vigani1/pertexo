import type { PoolClient } from 'pg';
import type { Role } from '@pertexo/policy';
import { ApiTokenPolicyError } from './api-token.errors.js';
import type { ApiTokenOwner } from './api-token.types.js';
import { tokenOwnerMayAct } from './policy.js';
import { readTokenOwnerStanding } from './authority.repository.js';

export type TokenOwnerAuthority = Readonly<{ revision: number; role: Role }>;
/**
 * Off withWorkspaceAccess. A token is bound to the membership's revision, which
 * the helper doesn't return. Creating and revoking also lock the user for update,
 * so the helper's share lock would come first, and two commands by one person in
 * two workspaces could deadlock, each holding it and waiting for the other's update.
 */
export async function tokenOwnerAuthority(
  client: PoolClient,
  input: ApiTokenOwner,
  mode: 'read' | 'create' | 'revoke',
): Promise<TokenOwnerAuthority> {
  const { workspaceStatus, userStatus, membership } =
    await readTokenOwnerStanding(client, input, mode);
  if (
    !tokenOwnerMayAct(mode, {
      workspaceStatus,
      userStatus,
      membershipStatus: membership?.status,
    }) ||
    membership === undefined
  )
    throw new ApiTokenPolicyError('authority_inactive');
  return { revision: membership.roleRevision, role: membership.role };
}
