import { API_TOKEN_SCOPES } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

import type { ApiTokenScope } from '@pertexo/contracts';
import { hasCapability, type Role } from '@pertexo/workflow-model';
import { ApiTokenPolicyError, type ApiTokenOwner } from './contract.js';

export type TokenOwnerAuthority = Readonly<{ revision: number; role: Role }>;
export async function tokenOwnerAuthority(
  client: PoolClient,
  input: ApiTokenOwner,
  mode: 'read' | 'create' | 'revoke',
): Promise<TokenOwnerAuthority> {
  const locks = mode === 'read' ? '' : ' for update';
  const workspace = await client.query<{ status: string }>(
    `select status from app.workspaces where id=$1${locks}`,
    [input.workspaceId],
  );
  const user = await client.query<{ status: string }>(
    `select status from app.users where id=$1${locks}`,
    [input.ownerUserId],
  );
  const member = await client.query<{
    role: Role;
    status: string;
    role_revision: number;
  }>(
    `select role,status,role_revision from app.workspace_memberships where workspace_id=$1 and user_id=$2${locks}`,
    [input.workspaceId, input.ownerUserId],
  );
  const membership = member.rows[0];
  const allowedWorkspaceStatuses =
    mode === 'create'
      ? ['active']
      : ['active', 'suspended', 'pending_deletion'];
  const actorUnavailable =
    workspace.rows[0] === undefined ||
    !allowedWorkspaceStatuses.includes(workspace.rows[0].status) ||
    user.rows[0]?.status !== 'active' ||
    membership?.status !== 'active';
  if (actorUnavailable) throw new ApiTokenPolicyError('authority_inactive');
  return { revision: membership.role_revision, role: membership.role };
}
export function availableApiTokenScopes(role: Role): ApiTokenScope[] {
  return API_TOKEN_SCOPES.filter((scope) => hasCapability(role, scope));
}
