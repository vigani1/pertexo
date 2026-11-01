import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  workspaceInvitations as invitations,
  workspaceInvitationDeliveryAttempts as attempts,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

export async function lockDeliveryScope(
  client: PoolClient,
  workspaceId: string,
  invitationId: string,
  deliveryAttemptId: string,
): Promise<void> {
  const db = drizzle(client);
  await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.workspaceId, workspaceId),
        eq(invitations.id, invitationId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        eq(attempts.workspaceId, workspaceId),
        eq(attempts.invitationId, invitationId),
        eq(attempts.id, deliveryAttemptId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
}
