import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workspaceInvitationDeliveryAttempts as attempts,
  workspaceInvitations as invitations,
} from '@pertexo/database/schema';
import { INVITATION_TTL_MILLIS } from '../deadlines.js';
import { invitationSelection } from './state.repository.js';

type InvitationKey = Readonly<{ workspaceId: string; invitationId: string }>;

export async function lockInvitation(
  client: PoolClient,
  { workspaceId, invitationId }: InvitationKey,
) {
  const db = drizzle(client);
  const locked = await db
    .select(invitationSelection)
    .from(invitations)
    .where(
      and(
        eq(invitations.workspaceId, workspaceId),
        eq(invitations.id, invitationId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return locked[0];
}

/** A resend gets a new token and deadline; a revocation ends the invitation. */
export async function updateInvitation(
  client: PoolClient,
  { workspaceId, invitationId }: InvitationKey,
  change: Readonly<{
    operation: 'resend' | 'revoke';
    nextRevision: number;
    tokenDigest: string | undefined;
    mutationTime: Date;
  }>,
) {
  const { operation, nextRevision, mutationTime } = change;
  const db = drizzle(client);
  const updated = await db
    .update(invitations)
    .set(
      operation === 'resend'
        ? {
            revision: nextRevision,
            tokenDigest: change.tokenDigest,
            expiresAt: new Date(mutationTime.getTime() + INVITATION_TTL_MILLIS),
            deliveryStatus: 'queued',
            updatedAt: sql`clock_timestamp()`,
          }
        : {
            revision: nextRevision,
            status: 'revoked',
            revokedAt: sql`clock_timestamp()`,
            deliveryStatus: 'canceled',
            updatedAt: sql`clock_timestamp()`,
          },
    )
    .where(
      and(
        eq(invitations.workspaceId, workspaceId),
        eq(invitations.id, invitationId),
      ),
    )
    .returning(invitationSelection)
    .catch(rethrowQueryFailure);
  const updatedInvitation = updated[0];
  if (updatedInvitation === undefined)
    throw new Error('Invitation update returned no row');
  return Object.freeze(updatedInvitation);
}

/** The status of the latest delivery attempt for this revision, locked. */
export async function lockLatestDeliveryStatus(
  client: PoolClient,
  workspaceId: string,
  invitationId: string,
  revision: number,
): Promise<string | undefined> {
  const delivery = await drizzle(client)
    .select({ status: attempts.status })
    .from(attempts)
    .where(
      and(
        eq(attempts.workspaceId, workspaceId),
        eq(attempts.invitationId, invitationId),
        eq(attempts.invitationRevision, revision),
      ),
    )
    .orderBy(desc(attempts.createdAt), desc(attempts.id))
    .limit(1)
    .for('update')
    .catch(rethrowQueryFailure);
  return delivery[0]?.status;
}
