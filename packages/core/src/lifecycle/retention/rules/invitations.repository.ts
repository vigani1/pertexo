import {
  workspaceInvitations,
  workspaceInvitationDeliveryAttempts,
  workspaceInvitationAcceptanceIntents,
} from '@pertexo/database/schema';
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

// An unanswered invitation expires: its sealed tokens are dropped and
// pending deliveries and acceptances stop.
export const invitationExpiry = {
  name: 'invitation_expiry',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client);
    const page = db.$with('page').as(
      db
        .select({
          workspaceId: workspaceInvitations.workspaceId,
          id: workspaceInvitations.id,
        })
        .from(workspaceInvitations)
        .where(
          and(
            eq(workspaceInvitations.status, 'pending'),
            lte(workspaceInvitations.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .orderBy(
          asc(workspaceInvitations.expiresAt),
          asc(workspaceInvitations.id),
        )
        .limit(pageSize)
        .for('update', { skipLocked: true }),
    );
    const expired = db.$with('expired').as(
      db
        .update(workspaceInvitations)
        .set({
          status: 'expired',
          deliveryStatus: 'canceled',
          updatedAt: sql`clock_timestamp()`,
        })
        .from(page)
        .where(
          and(
            eq(workspaceInvitations.workspaceId, page.workspaceId),
            eq(workspaceInvitations.id, page.id),
          ),
        )
        .returning({
          workspaceId: workspaceInvitations.workspaceId,
          id: workspaceInvitations.id,
        }),
    );
    const attempts = db.$with('attempts').as(
      db
        .update(workspaceInvitationDeliveryAttempts)
        .set({
          status: sql`case when ${workspaceInvitationDeliveryAttempts.status} in ('queued','failed') then 'canceled' else ${workspaceInvitationDeliveryAttempts.status} end`,
          tokenCiphertext: null,
          tokenNonce: null,
          tokenTag: null,
          tokenKeyVersion: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .from(expired)
        .where(
          and(
            eq(
              workspaceInvitationDeliveryAttempts.workspaceId,
              expired.workspaceId,
            ),
            eq(workspaceInvitationDeliveryAttempts.invitationId, expired.id),
            inArray(workspaceInvitationDeliveryAttempts.status, [
              'queued',
              'failed',
              'unknown',
            ]),
          ),
        ),
    );
    const intents = db.$with('intents').as(
      db
        .update(workspaceInvitationAcceptanceIntents)
        .set({ status: 'superseded', updatedAt: sql`clock_timestamp()` })
        .from(expired)
        .where(
          and(
            eq(
              workspaceInvitationAcceptanceIntents.workspaceId,
              expired.workspaceId,
            ),
            eq(workspaceInvitationAcceptanceIntents.invitationId, expired.id),
            inArray(workspaceInvitationAcceptanceIntents.status, [
              'pending',
              'verified',
              'wrong_account',
            ]),
          ),
        ),
    );
    return (
      await db
        .with(page, expired, attempts, intents)
        .select({ one: sql`1` })
        .from(expired)
        .catch(rethrowQueryFailure)
    ).length;
  },
} as const;
export const acceptanceIntents = {
  name: 'invitation_acceptance_intents',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client);
    const page = db.$with('page').as(
      db
        .select({
          workspaceId: workspaceInvitationAcceptanceIntents.workspaceId,
          id: workspaceInvitationAcceptanceIntents.id,
        })
        .from(workspaceInvitationAcceptanceIntents)
        .where(
          or(
            lte(
              workspaceInvitationAcceptanceIntents.expiresAt,
              sql`clock_timestamp()`,
            ),
            eq(workspaceInvitationAcceptanceIntents.status, 'abandoned'),
          ),
        )
        .orderBy(
          asc(workspaceInvitationAcceptanceIntents.expiresAt),
          asc(workspaceInvitationAcceptanceIntents.id),
        )
        .limit(pageSize)
        .for('update', { skipLocked: true }),
    );
    return (
      await db
        .with(page)
        .delete(workspaceInvitationAcceptanceIntents)
        .where(
          exists(
            db
              .select({ one: sql`1` })
              .from(page)
              .where(
                and(
                  eq(
                    page.workspaceId,
                    workspaceInvitationAcceptanceIntents.workspaceId,
                  ),
                  eq(page.id, workspaceInvitationAcceptanceIntents.id),
                ),
              ),
          ),
        )
        .returning({ one: sql`1` })
        .catch(rethrowQueryFailure)
    ).length;
  },
} as const;
// A finished invitation keeps its recipient's address for 90 days.
export const invitationRecipients = {
  name: 'invitation_recipients',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client);
    const page = db.$with('page').as(
      db
        .select({
          id: workspaceInvitations.id,
          address:
            sql<string>`'minimized+'||${workspaceInvitations.id}::text||'@invalid.pertexo'`.as(
              'minimized_address',
            ),
        })
        .from(workspaceInvitations)
        .where(
          and(
            inArray(workspaceInvitations.status, [
              'accepted',
              'revoked',
              'expired',
            ]),
            sql`${workspaceInvitations.recipientEmail} not like 'minimized+%@invalid.pertexo'`,
            sql`coalesce(${workspaceInvitations.acceptedAt},${workspaceInvitations.revokedAt},${workspaceInvitations.updatedAt})<=clock_timestamp()-interval '90 days'`,
          ),
        )
        .orderBy(
          asc(
            sql`coalesce(${workspaceInvitations.acceptedAt},${workspaceInvitations.revokedAt},${workspaceInvitations.updatedAt})`,
          ),
          asc(workspaceInvitations.id),
        )
        .limit(pageSize)
        .for('update', { skipLocked: true }),
    );
    const intents = db.$with('intents').as(
      db
        .update(workspaceInvitationAcceptanceIntents)
        .set({
          verifiedUserId: null,
          verifiedSessionId: null,
          verifiedEmail: null,
          verifiedAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .from(page)
        .where(
          and(
            eq(workspaceInvitationAcceptanceIntents.invitationId, page.id),
            isNotNull(workspaceInvitationAcceptanceIntents.verifiedEmail),
          ),
        ),
    );
    return (
      await db
        .with(page, intents)
        .update(workspaceInvitations)
        .set({
          recipientEmail: sql`${page.address}`,
          normalizedEmail: sql`${page.address}`,
          updatedAt: sql`clock_timestamp()`,
        })
        .from(page)
        .where(eq(workspaceInvitations.id, page.id))
        .returning({ one: sql`1` })
        .catch(rethrowQueryFailure)
    ).length;
  },
} as const;
