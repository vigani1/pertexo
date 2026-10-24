import { alias } from 'drizzle-orm/pg-core';
import { and, eq, getTableName, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaceInvitationAcceptanceIntents as intents,
  workspaceInvitations as invitations,
} from '../../../schema/foundation.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { readEligibleAuthenticationSession } from '../../../identity/federation/sessions/authority.js';
import type { Pool } from 'pg';
import { z } from 'zod';

import { parseIdentityUuid } from '../../support.js';
import {
  withTenantScopedClient,
  withPlatformTransaction,
  withWorkspaceScope,
} from '../../transactions.js';
import type { AcceptanceStore } from './contract.js';
import { digest } from '../input.js';
import { selectIntent } from './state.queries.js';

export async function readInvitationAcceptance(
  pool: Pool,
  workspaceIdInput: Parameters<AcceptanceStore['readInvitationAcceptance']>[0],
  bindingDigestInput: Parameters<
    AcceptanceStore['readInvitationAcceptance']
  >[1],
): ReturnType<AcceptanceStore['readInvitationAcceptance']> {
  const workspaceId = parseIdentityUuid(workspaceIdInput);
  const bindingDigest = digest.parse(bindingDigestInput);
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
  raw: Parameters<AcceptanceStore['recordInvitationAcceptanceProof']>[0],
): ReturnType<AcceptanceStore['recordInvitationAcceptanceProof']> {
  const workspaceId = parseIdentityUuid(raw.workspaceId);
  const intentId = parseIdentityUuid(raw.intentId);
  const userId = parseIdentityUuid(raw.userId);
  const bindingDigest = digest.parse(raw.bindingDigest);
  const normalizedEmail = z
    .email()
    .parse(raw.verifiedEmail.trim())
    .normalize('NFKC')
    .toLowerCase();
  return withPlatformTransaction(pool, async (client) => {
    const source = await readEligibleAuthenticationSession(
      client,
      parseIdentityUuid(raw.sessionId),
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
      if (!['pending', 'verified', 'wrong_account'].includes(current.status))
        return null;
      const matches =
        current.recipient_email.normalize('NFKC').toLowerCase() ===
        normalizedEmail;
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
  workspaceIdInput: Parameters<
    AcceptanceStore['abandonInvitationAcceptance']
  >[0],
  intentIdInput: Parameters<AcceptanceStore['abandonInvitationAcceptance']>[1],
  bindingDigestInput: Parameters<
    AcceptanceStore['abandonInvitationAcceptance']
  >[2],
): ReturnType<AcceptanceStore['abandonInvitationAcceptance']> {
  const workspaceId = parseIdentityUuid(workspaceIdInput);
  const intentId = parseIdentityUuid(intentIdInput);
  const bindingDigest = digest.parse(bindingDigestInput);
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
          inArray(intents.status, ['pending', 'verified', 'wrong_account']),
        ),
      )
      .returning({ id: intents.id })
      .catch(rethrowQueryFailure);
    return updated.length === 1;
  });
}
