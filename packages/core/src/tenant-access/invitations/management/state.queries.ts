import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  users,
  workspaceMemberships,
  workspaceInvitations,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { Role } from '@pertexo/workflow-model';

import type { PoolClient } from 'pg';

import { lockWorkspaceRow } from '../../../shared/authority.queries.js';
import { WorkspaceInvitationCommandConflictError } from '../../errors.js';
import { isActiveMemberManager } from '../../members/manager.js';

/**
 * A command takes the workspace, then the actor's user and membership, for
 * update, as the member commands do, so no two wait on each other in a cycle. It
 * stays off withWorkspaceAccess: that helper's share lock on the user would come
 * first, and two commands by one person in two workspaces would each hold it and
 * wait for the other's update, dying with 40P01.
 */
export async function lockAuthorizedActor(
  client: PoolClient,
  workspaceId: string,
  actorUserId: string,
): Promise<Role> {
  const db = drizzle(client);
  if ((await lockWorkspaceRow(client, workspaceId)) !== 'active')
    throw new WorkspaceInvitationCommandConflictError(
      'actor_inactive',
      'The workspace is not active',
    );
  const person = alias(users, 'users');
  const membership = alias(workspaceMemberships, 'membership');
  const actor = await db
    .select({
      role: membership.role,
      status: membership.status,
      user_status: person.status,
    })
    .from(person)
    .innerJoin(membership, eq(membership.userId, person.id))
    .where(
      and(eq(person.id, actorUserId), eq(membership.workspaceId, workspaceId)),
    )
    .for('update', { of: [person, membership] })
    .catch(rethrowQueryFailure);
  const row = actor[0];
  if (!isActiveMemberManager(row))
    throw new WorkspaceInvitationCommandConflictError(
      'actor_inactive',
      'The actor is no longer allowed to manage invitations',
    );
  return row.role;
}

export const invitationSelection = {
  id: workspaceInvitations.id,
  workspaceId: workspaceInvitations.workspaceId,
  email: workspaceInvitations.recipientEmail,
  role: workspaceInvitations.role,
  status: workspaceInvitations.status,
  revision: workspaceInvitations.revision,
  deliveryStatus: workspaceInvitations.deliveryStatus,
  expiresAt: workspaceInvitations.expiresAt,
  createdAt: workspaceInvitations.createdAt,
  updatedAt: workspaceInvitations.updatedAt,
};
