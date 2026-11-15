import { and, eq, getTableName, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { Pool, PoolClient } from 'pg';
import { readEligibleAuthenticationSession } from '../../../identity/federation/sessions/authority.repository.js';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
  withWorkspaceScope,
} from '@pertexo/database/primitives';
import {
  workspaceInvitationAcceptanceIntents as intents,
  workspaceInvitations as invitations,
} from '@pertexo/database/schema';

import { withPlatformTransaction } from '@pertexo/database/platform';
import type {
  InvitationAcceptanceIntentRecord,
  RecordInvitationAcceptanceProofInput,
} from '../../tenant-access.types.js';
import { OPEN_INTENT_STATUSES } from '../open-intents.repository.js';
import { selectIntent } from './state.repository.js';

export async function readInvitationAcceptance(
  pool: Pool,
  workspaceId: string,
  bindingDigest: string,
): Promise<InvitationAcceptanceIntentRecord | null> {
  return withPlatformTransaction(pool, async (client) => {
    const intent = await withWorkspaceScope(client, { workspaceId }, (scoped) =>
      selectIntent(
        scoped,
        sql`${and(eq(intents.workspaceId, workspaceId), eq(intents.bindingDigest, bindingDigest))}`,
      ),
    );
    if (intent?.status !== 'verified') return intent;
    const source =
      intent.verifiedSessionId === null
        ? undefined
        : await readEligibleAuthenticationSession(
            client,
            intent.verifiedSessionId,
          );
    // A revoked proof must return to verification after a fresh sign-in.
    // Completion still checks the stored proof under lock.
    return source?.userId === intent.verifiedUserId
      ? intent
      : { ...intent, status: 'pending' as const };
  });
}

type IntentKey = Readonly<{
  workspaceId: string;
  intentId: string;
  bindingDigest: string;
}>;

/** The intent under its binding, with the invitation's recipient, locked. */
export async function lockIntentForProof(
  client: PoolClient,
  { workspaceId, intentId, bindingDigest }: IntentKey,
) {
  const db = drizzle(client);
  const locked = await db
    .select({
      accepted_user_id: intents.acceptedUserId,
      recipient_email: invitations.recipientEmail,
      expires_at: intents.expiresAt,
      status: intents.status,
    })
    .from(intents)
    .innerJoin(invitations, eq(invitations.id, intents.invitationId))
    .where(
      and(
        eq(intents.workspaceId, workspaceId),
        eq(intents.id, intentId),
        eq(intents.bindingDigest, bindingDigest),
      ),
    )
    .for('update', { of: alias(intents, getTableName(intents)) })
    .catch(rethrowQueryFailure);
  return locked[0];
}

export async function recordIntentVerification(
  client: PoolClient,
  { workspaceId, intentId, bindingDigest }: IntentKey,
  raw: RecordInvitationAcceptanceProofInput,
  matches: boolean,
): Promise<void> {
  const userId = raw.userId;
  const normalizedEmail = raw.verifiedEmail;
  const db = drizzle(client);
  await db
    .update(intents)
    .set({
      status: matches ? 'verified' : 'wrong_account',
      verifiedUserId: userId,
      verifiedEmail: normalizedEmail,
      verifiedAt: raw.verifiedAt,
      verifiedSessionId: raw.sessionId,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(intents.workspaceId, workspaceId),
        eq(intents.id, intentId),
        eq(intents.bindingDigest, bindingDigest),
      ),
    )
    .catch(rethrowQueryFailure);
}

export async function abandonInvitationAcceptance(
  pool: Pool,
  workspaceId: string,
  intentId: string,
  bindingDigest: string,
): Promise<boolean> {
  return withTenantScopedClient(pool, { workspaceId }, async (client) => {
    const updated = await drizzle(client)
      .update(intents)
      .set({
        status: 'abandoned',
        abandonedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(intents.workspaceId, workspaceId),
          eq(intents.id, intentId),
          eq(intents.bindingDigest, bindingDigest),
          inArray(intents.status, OPEN_INTENT_STATUSES),
        ),
      )
      .returning({ id: intents.id })
      .catch(rethrowQueryFailure);
    return updated.length === 1;
  });
}
