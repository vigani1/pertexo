import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import {
  rethrowQueryFailure,
  installTransactionScope,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import {
  workspaceInvitationBindingReplacementClaims as claims,
  workspaceInvitationAcceptanceIntents as intents,
  workspaceInvitations as invitations,
} from '@pertexo/database/schema';

import { expireWorkspaceInvitations } from '../expiration.repository.js';
import type {
  InvitationAcceptanceIntentRecord,
  ResolveInvitationAcceptanceInput,
} from '../../contract.js';
import {
  replacementLineageIsLive,
  selectIntent,
  selectReplacementClaim,
  selectReplacementIntent,
  type ReplacementClaimRow,
} from './state.queries.js';

export async function resolveInvitationAcceptance(
  pool: Pool,
  raw: ResolveInvitationAcceptanceInput,
): Promise<InvitationAcceptanceIntentRecord | null> {
  const workspaceId = raw.workspaceId;
  const invitationId = raw.invitationId;
  const intentId = raw.intentId;
  const tokenDigest = raw.tokenDigest;
  const bindingDigest = raw.bindingDigest;
  const csrfDigest = raw.csrfDigest;
  const priorBinding =
    raw.priorBinding === undefined
      ? undefined
      : {
          workspaceId: raw.priorBinding.workspaceId,
          intentId: raw.priorBinding.intentId,
          bindingDigest: raw.priorBinding.bindingDigest,
        };
  const identity = {
    workspaceId,
    invitationId,
    intentId,
    bindingDigest,
    csrfDigest,
  };
  return withTenantScopedClient(pool, { workspaceId }, async (client) => {
    const db = drizzle(client);
    const invitation = await db
      .select({
        revision: invitations.revision,
        expires_at: invitations.expiresAt,
        status: invitations.status,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.workspaceId, workspaceId),
          eq(invitations.id, invitationId),
          eq(invitations.tokenDigest, tokenDigest),
        ),
      )
      .for('update')
      .catch(rethrowQueryFailure);
    const current = invitation[0];
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
      await db
        .execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${priorBinding.bindingDigest},0))`,
        )
        .catch(rethrowQueryFailure);
    }

    if (priorBinding !== undefined) {
      const resolution = await resolveReplacementBinding(client, identity, {
        priorBinding,
        revision: current.revision,
        now,
      });
      if (resolution.kind === 'resolved') return resolution.intent;
    }
    const inserted = await insertAcceptanceIntent(client, identity, {
      revision: current.revision,
      expiresAt,
    });
    if (inserted.length !== 1) return null;
    if (priorBinding !== undefined) {
      await installTransactionScope(client, {
        workspaceId: priorBinding.workspaceId,
      });
      await db
        .update(intents)
        .set({
          status: 'abandoned',
          abandonedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(intents.workspaceId, priorBinding.workspaceId),
            eq(intents.id, priorBinding.intentId),
            eq(intents.bindingDigest, priorBinding.bindingDigest),
            inArray(intents.status, ['pending', 'verified', 'wrong_account']),
          ),
        )
        .catch(rethrowQueryFailure);
      await installTransactionScope(client, { workspaceId: workspaceId });
    }
    return selectIntent(client, eq(intents.id, intentId));
  });
}

type InvitationBindingIdentity = Readonly<{
  workspaceId: string;
  invitationId: string;
  intentId: string;
  bindingDigest: string;
  csrfDigest: string;
}>;
type PriorBinding = NonNullable<
  ResolveInvitationAcceptanceInput['priorBinding']
>;
type ReplacementResolution =
  | Readonly<{ kind: 'insert' }>
  | Readonly<{
      kind: 'resolved';
      intent: Awaited<ReturnType<typeof selectIntent>>;
    }>;
function insertAcceptanceIntent(
  client: PoolClient,
  {
    workspaceId,
    invitationId,
    intentId,
    bindingDigest,
    csrfDigest,
  }: InvitationBindingIdentity,
  { revision, expiresAt }: Readonly<{ revision: number; expiresAt: Date }>,
) {
  return drizzle(client)
    .insert(intents)
    .values({
      id: intentId,
      workspaceId,
      invitationId,
      invitationRevision: revision,
      bindingDigest,
      csrfDigest,
      status: 'pending',
      expiresAt,
    })
    .onConflictDoNothing({ target: intents.id })
    .returning({ id: intents.id })
    .catch(rethrowQueryFailure);
}
async function resolveReplacementBinding(
  client: PoolClient,
  identity: InvitationBindingIdentity,
  {
    priorBinding,
    revision,
    now,
  }: Readonly<{ priorBinding: PriorBinding; revision: number; now: Date }>,
): Promise<ReplacementResolution> {
  const { workspaceId, invitationId, intentId, bindingDigest, csrfDigest } =
    identity;

  await installTransactionScope(client, {
    workspaceId: priorBinding.workspaceId,
  });
  const db = drizzle(client);
  const claimInsert = await db
    .insert(claims)
    .values({
      priorWorkspaceId: priorBinding.workspaceId,
      priorIntentId: priorBinding.intentId,
      priorBindingDigest: priorBinding.bindingDigest,
      successorWorkspaceId: workspaceId,
      successorIntentId: intentId,
      successorInvitationId: invitationId,
      successorInvitationRevision: revision,
      successorBindingDigest: bindingDigest,
      successorCsrfDigest: csrfDigest,
    })
    .onConflictDoNothing({
      target: [
        claims.priorWorkspaceId,
        claims.priorIntentId,
        claims.priorBindingDigest,
      ],
    })
    .returning({ id: claims.priorIntentId })
    .catch(rethrowQueryFailure);
  if (claimInsert.length === 1) {
    await installTransactionScope(client, { workspaceId: workspaceId });
    return { kind: 'insert' };
  }

  const claimed = await selectReplacementClaim(client, priorBinding, {
    lock: true,
  });
  const claim = claimed[0];
  if (claim === undefined) return { kind: 'resolved', intent: null };
  const exactClaim = replacementClaimMatches(claim, identity, revision);

  await installTransactionScope(client, {
    workspaceId: claim.successor_workspace_id,
  });
  const claimedIntent = await selectReplacementIntent(
    client,
    claim.successor_workspace_id,
    claim.successor_intent_id,
  );
  const successor = claimedIntent[0];
  if (exactClaim) {
    const successorUnavailable =
      successor === undefined ||
      successor.status === 'abandoned' ||
      successor.status === 'superseded' ||
      successor.expires_at.getTime() <= now.getTime();
    if (successorUnavailable) return { kind: 'resolved', intent: null };
    return {
      kind: 'resolved',
      intent: await selectIntent(client, eq(intents.id, intentId)),
    };
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
    return { kind: 'resolved', intent: null };

  await installTransactionScope(client, { workspaceId: workspaceId });
  const staleCandidate = await db
    .select({ id: intents.id })
    .from(intents)
    .where(and(eq(intents.workspaceId, workspaceId), eq(intents.id, intentId)))
    .catch(rethrowQueryFailure);
  if (staleCandidate.length !== 0) return { kind: 'resolved', intent: null };

  await installTransactionScope(client, {
    workspaceId: priorBinding.workspaceId,
  });
  await db
    .update(claims)
    .set({
      successorWorkspaceId: workspaceId,
      successorIntentId: intentId,
      successorInvitationId: invitationId,
      successorInvitationRevision: revision,
      successorBindingDigest: bindingDigest,
      successorCsrfDigest: csrfDigest,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(claims.priorWorkspaceId, priorBinding.workspaceId),
        eq(claims.priorIntentId, priorBinding.intentId),
        eq(claims.priorBindingDigest, priorBinding.bindingDigest),
      ),
    )
    .catch(rethrowQueryFailure);
  await installTransactionScope(client, { workspaceId: workspaceId });
  return { kind: 'insert' };
}
function replacementClaimMatches(
  claim: ReplacementClaimRow,
  {
    workspaceId,
    invitationId,
    intentId,
    bindingDigest,
    csrfDigest,
  }: InvitationBindingIdentity,
  revision: number,
): boolean {
  return (
    claim.successor_workspace_id === workspaceId &&
    claim.successor_intent_id === intentId &&
    claim.successor_invitation_id === invitationId &&
    claim.successor_invitation_revision === revision &&
    claim.successor_binding_digest === bindingDigest &&
    claim.successor_csrf_digest === csrfDigest
  );
}
