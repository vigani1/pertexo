import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  users,
  workspaceMemberships,
  workspaceInvitations,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

import type { PoolClient } from 'pg';

/** The actor's user and membership in the workspace, locked for update. */
export async function lockActorMembership(
  client: PoolClient,
  workspaceId: string,
  actorUserId: string,
) {
  const db = drizzle(client);
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
  return actor[0];
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
