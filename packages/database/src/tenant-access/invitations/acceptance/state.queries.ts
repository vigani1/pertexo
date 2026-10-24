import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { InvitationAcceptanceIntentRecord } from '../../contract.js';

import { acceptanceReceiptSchema } from '../receipts.repository.js';

import {
  delegatedRole,
  type IntentRow,
  type ReplacementClaimRow,
  type ReplacementIntentRow,
  intentSelection,
} from './contract.js';

function mapIntent(row: IntentRow): InvitationAcceptanceIntentRecord {
  const parsedReceipt =
    row.receipt === null ? null : acceptanceReceiptSchema.parse(row.receipt);
  return Object.freeze({
    id: z.uuid().parse(row.id),
    workspaceId: z.uuid().parse(row.workspace_id),
    invitationId: z.uuid().parse(row.invitation_id),
    invitationRevision: z
      .number()
      .int()
      .positive()
      .parse(row.invitation_revision),
    status: z
      .enum([
        'pending',
        'verified',
        'wrong_account',
        'completed',
        'abandoned',
        'superseded',
      ])
      .parse(row.status),
    expiresAt: z.coerce.date().parse(row.expires_at),
    verifiedUserId:
      row.verified_user_id === null
        ? null
        : z.uuid().parse(row.verified_user_id),
    verifiedSessionId: row.verified_session_id,
    verifiedEmail: row.verified_email,
    verifiedAt:
      row.verified_at === null ? null : z.coerce.date().parse(row.verified_at),
    workspaceName: row.workspace_name,
    invitationRole:
      row.invitation_role === null
        ? null
        : delegatedRole.parse(row.invitation_role),
    invitationStatus:
      row.invitation_status === null
        ? null
        : z
            .enum(['pending', 'accepted', 'revoked', 'expired'])
            .parse(row.invitation_status),
    acceptedUserId:
      row.accepted_user_id === null
        ? null
        : z.uuid().parse(row.accepted_user_id),
    receipt: parsedReceipt,
  });
}

export async function selectIntent(
  client: PoolClient,
  clause: string,
  values: readonly unknown[],
  { lock = false }: Readonly<{ lock?: boolean | undefined }> = {},
): Promise<InvitationAcceptanceIntentRecord | null> {
  const result = await client.query<IntentRow>(
    `select ${intentSelection}
       from app.workspace_invitation_acceptance_intents intent
       left join app.workspace_invitations invitation on invitation.id=intent.invitation_id
       left join app.workspaces workspace on workspace.id=intent.workspace_id
      where ${clause}${lock ? ' for update of intent' : ''}`,
    [...values],
  );
  return result.rows[0] === undefined ? null : mapIntent(result.rows[0]);
}

export async function replacementLineageIsLive(
  client: PoolClient,
  initial: Readonly<{
    workspaceId: string;
    intentId: string;
    bindingDigest: string;
    intent: ReplacementIntentRow | undefined;
  }>,
  now: Date,
): Promise<boolean> {
  let current = initial;
  const visited = new Set<string>();
  for (let depth = 0; depth < 32; depth += 1) {
    const identity = `${current.workspaceId}:${current.intentId}`;
    if (visited.has(identity)) return true;
    visited.add(identity);
    const intentStillUsable =
      current.intent !== undefined &&
      current.intent.status !== 'abandoned' &&
      current.intent.status !== 'superseded' &&
      current.intent.expires_at.getTime() > now.getTime();
    if (intentStillUsable) return true;
    const claimResult = await client.query<ReplacementClaimRow>(
      `select successor_workspace_id,successor_intent_id,
              successor_invitation_id,successor_invitation_revision,
              successor_binding_digest,successor_csrf_digest
         from app.workspace_invitation_binding_replacement_claims
        where prior_workspace_id=$1 and prior_intent_id=$2
          and prior_binding_digest=$3`,
      [current.workspaceId, current.intentId, current.bindingDigest],
    );
    const claim = claimResult.rows[0];
    if (claim === undefined) return false;
    await client.query("select set_config('app.workspace_id',$1,true)", [
      claim.successor_workspace_id,
    ]);
    const intentResult = await client.query<ReplacementIntentRow>(
      `select id,invitation_id,invitation_revision,binding_digest,
              csrf_digest,status,expires_at
         from app.workspace_invitation_acceptance_intents
        where workspace_id=$1 and id=$2
        for update`,
      [claim.successor_workspace_id, claim.successor_intent_id],
    );
    current = {
      workspaceId: claim.successor_workspace_id,
      intentId: claim.successor_intent_id,
      bindingDigest: claim.successor_binding_digest,
      intent: intentResult.rows[0],
    };
  }
  return true;
}
