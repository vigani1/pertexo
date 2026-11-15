import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workspaceInvitations as invitations,
  users,
  workspaceMemberships,
  workspaces,
} from '@pertexo/database/schema';

/** Workspace first, then the user: the shared lock order. */
export async function lockAcceptanceParties(
  client: PoolClient,
  workspaceId: string,
  actorUserId: string,
) {
  const db = drizzle(client);
  const workspace = await db
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('update')
    .catch(rethrowQueryFailure);
  const user = await db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, actorUserId))
    .for('update')
    .catch(rethrowQueryFailure);
  return {
    workspaceStatus: workspace[0]?.status,
    userStatus: user[0]?.status,
  };
}

/** The actor's membership, then the invitation, both locked. */
export async function lockAcceptanceRows(
  client: PoolClient,
  {
    workspaceId,
    actorUserId,
    invitationId,
  }: Readonly<{
    workspaceId: string;
    actorUserId: string;
    invitationId: string;
  }>,
) {
  const db = drizzle(client);
  const membership = await db
    .select({
      role: workspaceMemberships.role,
      status: workspaceMemberships.status,
      role_revision: workspaceMemberships.roleRevision,
    })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, actorUserId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const invitation = await db
    .select({
      status: invitations.status,
      revision: invitations.revision,
      role: invitations.role,
      email: invitations.normalizedEmail,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .where(
      and(
        eq(invitations.workspaceId, workspaceId),
        eq(invitations.id, invitationId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return { membership, invitation };
}
