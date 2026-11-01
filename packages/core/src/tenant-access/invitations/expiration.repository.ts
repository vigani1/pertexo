import { and, eq, exists, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaceInvitations as invitations,
  workspaceInvitationDeliveryAttempts as attempts,
  workspaceInvitationAcceptanceIntents as intents,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

import { cancelOpenInvitationDeliveries } from './delivery-cancellation.repository.js';

type ExpirationScope = Readonly<
  | { workspaceId: string; invitationId: string; normalizedEmail?: never }
  | { workspaceId: string; normalizedEmail: string; invitationId?: never }
  | { workspaceId: string; invitationId?: never; normalizedEmail?: never }
>;

/** Invitation row first, then delivery and acceptance evidence in one transaction. */
export async function expireWorkspaceInvitations(
  client: PoolClient,
  scope: ExpirationScope,
): Promise<number> {
  const db = drizzle(client);
  const scopeFilter = and(
    eq(invitations.workspaceId, scope.workspaceId),
    scope.invitationId === undefined
      ? undefined
      : eq(invitations.id, scope.invitationId),
    scope.normalizedEmail === undefined
      ? undefined
      : eq(invitations.normalizedEmail, scope.normalizedEmail),
  );
  const newlyExpired = await db
    .update(invitations)
    .set({
      status: 'expired',
      deliveryStatus: 'canceled',
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        scopeFilter,
        eq(invitations.status, 'pending'),
        lte(invitations.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .returning({ id: invitations.id })
    .catch(rethrowQueryFailure);
  // Earlier expiration paths could leave open evidence behind. Retire that
  // evidence idempotently too, without rewriting terminal delivery history.
  const openAttempt = db
    .select({ one: sql`1` })
    .from(attempts)
    .where(
      and(
        eq(attempts.workspaceId, invitations.workspaceId),
        eq(attempts.invitationId, invitations.id),
        or(
          inArray(attempts.status, ['queued', 'failed']),
          and(
            eq(attempts.status, 'unknown'),
            isNotNull(attempts.tokenCiphertext),
          ),
        ),
      ),
    );
  const openIntent = db
    .select({ one: sql`1` })
    .from(intents)
    .where(
      and(
        eq(intents.workspaceId, invitations.workspaceId),
        eq(intents.invitationId, invitations.id),
        inArray(intents.status, ['pending', 'verified', 'wrong_account']),
      ),
    );
  const outstanding = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        scopeFilter,
        eq(invitations.status, 'expired'),
        or(exists(openAttempt), exists(openIntent)),
      ),
    )
    .orderBy(invitations.id)
    .for('update')
    .catch(rethrowQueryFailure);
  for (const invitationId of new Set(
    [...newlyExpired, ...outstanding].map(({ id }) => id).sort(),
  )) {
    await cancelOpenInvitationDeliveries(
      client,
      scope.workspaceId,
      invitationId,
    );
    await db
      .update(intents)
      .set({ status: 'superseded', updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(intents.workspaceId, scope.workspaceId),
          eq(intents.invitationId, invitationId),
          inArray(intents.status, ['pending', 'verified', 'wrong_account']),
        ),
      )
      .catch(rethrowQueryFailure);
  }
  return newlyExpired.length;
}
