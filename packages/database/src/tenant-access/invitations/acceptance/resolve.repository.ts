import type { Pool, PoolClient } from 'pg';

import { expireWorkspaceInvitations } from '../expiration.repository.js';
import { parseIdentityUuid } from '../../support.js';
import { withTenantScopedClient } from '../../transactions.js';
import {
  type AcceptanceStore,
  digest,
  type ReplacementClaimRow,
  type ReplacementIntentRow,
} from './contract.js';
import { selectIntent, replacementLineageIsLive } from './state.queries.js';

export async function resolveInvitationAcceptance(
  pool: Pool,
  raw: Parameters<AcceptanceStore['resolveInvitationAcceptance']>[0],
): ReturnType<AcceptanceStore['resolveInvitationAcceptance']> {
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
  const identity = {
    workspaceId,
    invitationId,
    intentId,
    bindingDigest,
    csrfDigest,
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
}

type InvitationBindingIdentity = Readonly<{
  workspaceId: string;
  invitationId: string;
  intentId: string;
  bindingDigest: string;
  csrfDigest: string;
}>;
type PriorBinding = NonNullable<
  Parameters<AcceptanceStore['resolveInvitationAcceptance']>[0]['priorBinding']
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
  return client.query<{ id: string }>(
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
      revision,
      bindingDigest,
      csrfDigest,
      expiresAt,
    ],
  );
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
      revision,
      bindingDigest,
      csrfDigest,
    ],
  );
  if (claimInsert.rowCount === 1) {
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    return { kind: 'insert' };
  }

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
  if (claim === undefined) return { kind: 'resolved', intent: null };
  const exactClaim = replacementClaimMatches(claim, identity, revision);

  await client.query("select set_config('app.workspace_id',$1,true)", [
    claim.successor_workspace_id,
  ]);
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
    const successorUnavailable =
      successor === undefined ||
      successor.status === 'abandoned' ||
      successor.status === 'superseded' ||
      successor.expires_at.getTime() <= now.getTime();
    if (successorUnavailable) return { kind: 'resolved', intent: null };
    return {
      kind: 'resolved',
      intent: await selectIntent(client, 'intent.id=$1', [intentId]),
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

  await client.query("select set_config('app.workspace_id',$1,true)", [
    workspaceId,
  ]);
  const staleCandidate = await client.query<{ id: string }>(
    `select id from app.workspace_invitation_acceptance_intents
              where workspace_id=$1 and id=$2`,
    [workspaceId, intentId],
  );
  if (staleCandidate.rowCount !== 0) return { kind: 'resolved', intent: null };

  await client.query("select set_config('app.workspace_id',$1,true)", [
    priorBinding.workspaceId,
  ]);
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
      revision,
      bindingDigest,
      csrfDigest,
    ],
  );
  await client.query("select set_config('app.workspace_id',$1,true)", [
    workspaceId,
  ]);
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
