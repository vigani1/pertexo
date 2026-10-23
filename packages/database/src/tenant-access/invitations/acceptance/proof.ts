import { readEligibleAuthenticationSession } from '../../../identity/federation/sessions/authority.js';
import type { Pool } from 'pg';
import { z } from 'zod';

import { parseIdentityUuid } from '../../support.js';
import {
  withTenantScopedClient,
  withPlatformTransaction,
  withWorkspaceScope,
} from '../../transactions.js';
import { type AcceptanceStore, digest } from './contract.js';
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
        'intent.workspace_id=$1 and intent.binding_digest=$2',
        [workspaceId, bindingDigest],
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
      const locked = await client.query<{
        accepted_user_id: string | null;
        recipient_email: string;
        expires_at: Date;
        status: string;
      }>(
        `select invitation.recipient_email,intent.expires_at,intent.status,
                  intent.accepted_user_id
             from app.workspace_invitation_acceptance_intents intent
             join app.workspace_invitations invitation on invitation.id=intent.invitation_id
            where intent.workspace_id=$1 and intent.id=$2 and intent.binding_digest=$3
            for update of intent`,
        [workspaceId, intentId, bindingDigest],
      );
      const current = locked.rows[0];
      if (
        current === undefined ||
        current.expires_at.getTime() <= raw.verifiedAt.getTime()
      )
        return null;
      if (current.status === 'completed')
        return current.accepted_user_id === userId
          ? selectIntent(client, 'intent.id=$1', [intentId])
          : null;
      if (!['pending', 'verified', 'wrong_account'].includes(current.status))
        return null;
      const matches =
        current.recipient_email.normalize('NFKC').toLowerCase() ===
        normalizedEmail;
      await client.query(
        `update app.workspace_invitation_acceptance_intents
              set status=$4,verified_user_id=$5,verified_email=$6,verified_at=$7,verified_session_id=$8,
                  updated_at=clock_timestamp()
            where workspace_id=$1 and id=$2 and binding_digest=$3`,
        [
          workspaceId,
          intentId,
          bindingDigest,
          matches ? 'verified' : 'wrong_account',
          userId,
          normalizedEmail,
          raw.verifiedAt,
          raw.sessionId,
        ],
      );
      return selectIntent(client, 'intent.id=$1', [intentId]);
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
    const updated = await client.query(
      `update app.workspace_invitation_acceptance_intents
              set status='abandoned',abandoned_at=clock_timestamp(),updated_at=clock_timestamp()
            where workspace_id=$1 and id=$2 and binding_digest=$3
              and status in ('pending','verified','wrong_account')`,
      [workspaceId, intentId, bindingDigest],
    );
    return updated.rowCount === 1;
  });
}
