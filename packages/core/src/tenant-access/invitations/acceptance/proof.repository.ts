import { canonicalEmail } from '@pertexo/workflow-model';
import { and, eq, getTableName, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
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
} from '../../contract.js';
import { OPEN_INTENT_STATUSES } from '../open-intents.repository.js';
import { selectIntent } from './state.queries.js';

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

export async function recordInvitationAcceptanceProof(
  pool: Pool,
  raw: RecordInvitationAcceptanceProofInput,
): Promise<InvitationAcceptanceIntentRecord | null> {
  const workspaceId = raw.workspaceId;
  const intentId = raw.intentId;
  const userId = raw.userId;
  const bindingDigest = raw.bindingDigest;
  const normalizedEmail = raw.verifiedEmail;
  return withPlatformTransaction(pool, async (client) => {
    const source = await readEligibleAuthenticationSession(
      client,
      raw.sessionId,
    );
    if (source?.userId !== userId) return null;
    return withWorkspaceScope(client, { workspaceId }, async (client) => {
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
      const current = locked[0];
      if (
        current === undefined ||
        current.expires_at.getTime() <= raw.verifiedAt.getTime()
      )
        return null;
      if (current.status === 'completed')
        return current.accepted_user_id === userId
          ? selectIntent(client, eq(intents.id, intentId))
          : null;
      if (!(OPEN_INTENT_STATUSES as readonly string[]).includes(current.status))
        return null;
      const matches =
        canonicalEmail(current.recipient_email) === normalizedEmail;
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
      return selectIntent(client, eq(intents.id, intentId));
    });
  });
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
