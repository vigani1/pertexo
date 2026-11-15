import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  isUniqueConstraintFailure,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import { workspaceInvitations as invitations } from '@pertexo/database/schema';
import type { CreateWorkspaceInvitationInput } from '../../tenant-access.types.js';
import { invitationSelection } from './state.repository.js';

/** Whether a pending invitation to this email exists, locking it. */
export async function lockPendingInvitation(
  client: PoolClient,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  const db = drizzle(client);
  const duplicate = await db
    .select({ one: sql`1` })
    .from(invitations)
    .where(
      and(
        eq(invitations.workspaceId, workspaceId),
        eq(invitations.normalizedEmail, email),
        eq(invitations.status, 'pending'),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return duplicate.length > 0;
}

/** A unique pending invitation that raced in reads as `duplicate`. */
export async function insertInvitation(
  client: PoolClient,
  values: Readonly<{
    invitationId: string;
    workspaceId: string;
    email: string;
    role: CreateWorkspaceInvitationInput['role'];
    tokenDigest: string;
    actorUserId: string;
    expiresAt: Date;
  }>,
) {
  const { invitationId, workspaceId, email, role, tokenDigest, actorUserId } =
    values;
  try {
    const inserted = await drizzle(client)
      .insert(invitations)
      .values({
        id: invitationId,
        workspaceId,
        recipientEmail: email,
        normalizedEmail: email,
        role,
        status: 'pending',
        revision: 1,
        tokenDigest,
        deliveryStatus: 'queued',
        createdBy: actorUserId,
        expiresAt: values.expiresAt,
      })
      .returning(invitationSelection)
      .catch(rethrowQueryFailure);
    const insertedInvitation = inserted[0];
    if (insertedInvitation === undefined)
      throw new Error('Invitation insert returned no row');
    return {
      kind: 'inserted',
      invitation: Object.freeze(insertedInvitation),
    } as const;
  } catch (error: unknown) {
    if (isUniqueConstraintFailure(error))
      return { kind: 'duplicate', cause: error } as const;
    throw error;
  }
}
