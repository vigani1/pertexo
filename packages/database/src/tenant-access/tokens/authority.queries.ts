import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  users,
  workspaces,
  workspaceMemberships,
} from '../../schema/foundation.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { API_TOKEN_SCOPES } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

import type { ApiTokenScope } from '@pertexo/contracts';
import { hasCapability, type Role } from '@pertexo/workflow-model';
import { ApiTokenPolicyError } from './errors.js';
import type { ApiTokenOwner } from './contract.js';

export type TokenOwnerAuthority = Readonly<{ revision: number; role: Role }>;
export async function tokenOwnerAuthority(
  client: PoolClient,
  input: ApiTokenOwner,
  mode: 'read' | 'create' | 'revoke',
): Promise<TokenOwnerAuthority> {
  const db = drizzle(client);
  const workspaceQuery = db
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId));
  const workspace = await (
    mode === 'read' ? workspaceQuery : workspaceQuery.for('update')
  ).catch(rethrowQueryFailure);
  const userQuery = db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, input.ownerUserId));
  const user = await (
    mode === 'read' ? userQuery : userQuery.for('update')
  ).catch(rethrowQueryFailure);
  const memberQuery = db
    .select({
      role: workspaceMemberships.role,
      status: workspaceMemberships.status,
      roleRevision: workspaceMemberships.roleRevision,
    })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        eq(workspaceMemberships.userId, input.ownerUserId),
      ),
    );
  const member = await (
    mode === 'read' ? memberQuery : memberQuery.for('update')
  ).catch(rethrowQueryFailure);
  const membership = member[0];
  const allowedWorkspaceStatuses =
    mode === 'create'
      ? ['active']
      : ['active', 'suspended', 'pending_deletion'];
  const actorUnavailable =
    workspace[0] === undefined ||
    !allowedWorkspaceStatuses.includes(workspace[0].status) ||
    user[0]?.status !== 'active' ||
    membership?.status !== 'active';
  if (actorUnavailable) throw new ApiTokenPolicyError('authority_inactive');
  return { revision: membership.roleRevision, role: membership.role };
}
export function availableApiTokenScopes(role: Role): ApiTokenScope[] {
  return API_TOKEN_SCOPES.filter((scope) => hasCapability(role, scope));
}
