import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  users,
  workspaces,
  workspaceMemberships,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

import type { Role } from '@pertexo/workflow-model';
import { ApiTokenPolicyError } from './errors.js';
import type { ApiTokenOwner } from './contract.js';
import { tokenOwnerMayAct } from './policy.js';

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
  if (
    !tokenOwnerMayAct(mode, {
      workspaceStatus: workspace[0]?.status,
      userStatus: user[0]?.status,
      membershipStatus: membership?.status,
    }) ||
    membership === undefined
  )
    throw new ApiTokenPolicyError('authority_inactive');
  return { revision: membership.roleRevision, role: membership.role };
}
