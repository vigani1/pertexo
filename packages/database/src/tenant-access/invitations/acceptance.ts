import { readEligibleAuthenticationSession } from '../../identity/federation/sessions/authority.js';
import type { Pool } from 'pg';
import { z } from 'zod';

import type {
  CompleteInvitationAcceptanceInput,
  ResolveInvitationAcceptanceInput,
} from '../contracts.js';

import { expireWorkspaceInvitations } from './expiration.js';

import { parseIdentityUuid } from '../support.js';
import {
  withTenantScopedClient,
  withPlatformTransaction,
  withWorkspaceScope,
} from '../transactions.js';
import {
  type AcceptanceStore,
  digest,
  type ReplacementClaimRow,
  type ReplacementIntentRow,
} from './acceptance/contract.js';
import {
  selectIntent,
  replacementLineageIsLive,
} from './acceptance/state.queries.js';
import { completeAcceptance } from './acceptance/complete.js';

export function createIdentityWorkspaceInvitationAcceptanceStore(
  pool: Pool,
): AcceptanceStore {
  return Object.freeze({
    resolveInvitationAcceptance: async (
      raw: ResolveInvitationAcceptanceInput,
    ) => {
      const workspaceId = parseIdentityUuid(raw.workspaceId);
      const invitationId = parseIdentityUuid(raw.invitationId);
      const intentId = parseIdentityUuid(raw.intentId);
      const tokenDigest = digest.parse(raw.tokenDigest);
      const bindingDigest = digest.parse(raw.bindingDigest);
      const csrfDigest = digest.parse(raw.csrfDigest);
      const priorBinding =
        raw.priorBinding === undefined
          ? undefined
          : {
              workspaceId: parseIdentityUuid(raw.priorBinding.workspaceId),
              intentId: parseIdentityUuid(raw.priorBinding.intentId),
              bindingDigest: digest.parse(raw.priorBinding.bindingDigest),
            };
      return withTenantScopedClient(pool, { workspaceId }, async (client) => {
        const invitation = await client.query<{
          revision: number;
          expires_at: Date;
          status: string;
        }>(
          `select revision,expires_at,status from app.workspace_invitations
            where workspace_id=$1 and id=$2 and token_digest=$3 for update`,
          [workspaceId, invitationId, tokenDigest],
        );
        const current = invitation.rows[0];
        if (current?.status !== 'pending') return null;
        const now = new Date();
        if (current.expires_at.getTime() <= now.getTime()) {
          await expireWorkspaceInvitations(client, {
            workspaceId,
            invitationId,
          });
          return null;
        }
        const expiresAt = new Date(
          Math.min(raw.expiresAt.getTime(), current.expires_at.getTime()),
        );
        if (priorBinding !== undefined) {
          await client.query(
            'select pg_advisory_xact_lock(hashtextextended($1,0))',
            [priorBinding.bindingDigest],
          );
        }
        const insertIntent = () =>
          client.query<{ id: string }>(
            `insert into app.workspace_invitation_acceptance_intents
             (id,workspace_id,invitation_id,invitation_revision,binding_digest,
              csrf_digest,status,expires_at)
           values($1,$2,$3,$4,$5,$6,'pending',$7)
           on conflict(id) do nothing
           returning id`,
            [
              intentId,
              workspaceId,
              invitationId,
              current.revision,
              bindingDigest,
              csrfDigest,
              expiresAt,
            ],
          );
        let inserted;
        if (priorBinding !== undefined) {
          await client.query("select set_config('app.workspace_id',$1,true)", [
            priorBinding.workspaceId,
          ]);
          const claimInsert = await client.query(
            `insert into app.workspace_invitation_binding_replacement_claims
             (prior_workspace_id,prior_intent_id,prior_binding_digest,
              successor_workspace_id,successor_intent_id,successor_invitation_id,
              successor_invitation_revision,successor_binding_digest,successor_csrf_digest)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9)
             on conflict(prior_workspace_id,prior_intent_id,prior_binding_digest)
             do nothing`,
            [
              priorBinding.workspaceId,
              priorBinding.intentId,
              priorBinding.bindingDigest,
              workspaceId,
              intentId,
              invitationId,
              current.revision,
              bindingDigest,
              csrfDigest,
            ],
          );
          if (claimInsert.rowCount === 1) {
            await client.query(
              "select set_config('app.workspace_id',$1,true)",
              [workspaceId],
            );
            inserted = await insertIntent();
          } else {
            const claimed = await client.query<ReplacementClaimRow>(
              `select successor_workspace_id,successor_intent_id,
                    successor_invitation_id,successor_invitation_revision,
                    successor_binding_digest,successor_csrf_digest
               from app.workspace_invitation_binding_replacement_claims
              where prior_workspace_id=$1 and prior_intent_id=$2
                and prior_binding_digest=$3
              for update`,
              [
                priorBinding.workspaceId,
                priorBinding.intentId,
                priorBinding.bindingDigest,
              ],
            );
            const claim = claimed.rows[0];
            if (claim === undefined) return null;
            const exactClaim =
              claim.successor_workspace_id === workspaceId &&
              claim.successor_intent_id === intentId &&
              claim.successor_invitation_id === invitationId &&
              claim.successor_invitation_revision === current.revision &&
              claim.successor_binding_digest === bindingDigest &&
              claim.successor_csrf_digest === csrfDigest;

            await client.query(
              "select set_config('app.workspace_id',$1,true)",
              [claim.successor_workspace_id],
            );
            const claimedIntent = await client.query<ReplacementIntentRow>(
              `select id,invitation_id,invitation_revision,binding_digest,
                    csrf_digest,status,expires_at
               from app.workspace_invitation_acceptance_intents
              where workspace_id=$1 and id=$2
              for update`,
              [claim.successor_workspace_id, claim.successor_intent_id],
            );
            const successor = claimedIntent.rows[0];
            if (exactClaim) {
              if (
                successor === undefined ||
                successor.status === 'abandoned' ||
                successor.status === 'superseded' ||
                successor.expires_at.getTime() <= now.getTime()
              )
                return null;
              return selectIntent(client, 'intent.id=$1', [intentId]);
            }
            if (
              await replacementLineageIsLive(
                client,
                {
                  workspaceId: claim.successor_workspace_id,
                  intentId: claim.successor_intent_id,
                  bindingDigest: claim.successor_binding_digest,
                  intent: successor,
                },
                now,
              )
            )
              return null;

            await client.query(
              "select set_config('app.workspace_id',$1,true)",
              [workspaceId],
            );
            const staleCandidate = await client.query<{ id: string }>(
              `select id from app.workspace_invitation_acceptance_intents
              where workspace_id=$1 and id=$2`,
              [workspaceId, intentId],
            );
            if (staleCandidate.rowCount !== 0) return null;

            await client.query(
              "select set_config('app.workspace_id',$1,true)",
              [priorBinding.workspaceId],
            );
            await client.query(
              `update app.workspace_invitation_binding_replacement_claims
                set successor_workspace_id=$4,successor_intent_id=$5,
                    successor_invitation_id=$6,successor_invitation_revision=$7,
                    successor_binding_digest=$8,successor_csrf_digest=$9,
                    updated_at=clock_timestamp()
              where prior_workspace_id=$1 and prior_intent_id=$2
                and prior_binding_digest=$3`,
              [
                priorBinding.workspaceId,
                priorBinding.intentId,
                priorBinding.bindingDigest,
                workspaceId,
                intentId,
                invitationId,
                current.revision,
                bindingDigest,
                csrfDigest,
              ],
            );
            await client.query(
              "select set_config('app.workspace_id',$1,true)",
              [workspaceId],
            );
            inserted = await insertIntent();
          }
        } else {
          inserted = await insertIntent();
        }
        if (inserted.rowCount !== 1) return null;
        if (priorBinding !== undefined) {
          await client.query("select set_config('app.workspace_id',$1,true)", [
            priorBinding.workspaceId,
          ]);
          await client.query(
            `update app.workspace_invitation_acceptance_intents
                set status='abandoned',abandoned_at=clock_timestamp(),updated_at=clock_timestamp()
              where workspace_id=$1 and id=$2 and binding_digest=$3
                and status in ('pending','verified','wrong_account')`,
            [
              priorBinding.workspaceId,
              priorBinding.intentId,
              priorBinding.bindingDigest,
            ],
          );
          await client.query("select set_config('app.workspace_id',$1,true)", [
            workspaceId,
          ]);
        }
        return selectIntent(client, 'intent.id=$1', [intentId]);
      });
    },

    readInvitationAcceptance: async (workspaceIdInput, bindingDigestInput) => {
      const workspaceId = parseIdentityUuid(workspaceIdInput);
      const bindingDigest = digest.parse(bindingDigestInput);
      return withPlatformTransaction(pool, async (client) => {
        const intent = await withWorkspaceScope(
          client,
          { workspaceId },
          (scoped) =>
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
    },

    recordInvitationAcceptanceProof: async (raw) => {
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
          if (
            !['pending', 'verified', 'wrong_account'].includes(current.status)
          )
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
    },

    completeInvitationAcceptance: async (
      raw: CompleteInvitationAcceptanceInput,
    ) => completeAcceptance(pool, raw),

    abandonInvitationAcceptance: async (
      workspaceIdInput,
      intentIdInput,
      bindingDigestInput,
    ) => {
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
    },
  });
}
