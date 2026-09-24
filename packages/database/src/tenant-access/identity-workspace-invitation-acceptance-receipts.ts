import type { PoolClient } from 'pg';
import { z } from 'zod';

import { generatePersistedId } from '../platform/persisted-id.js';
import type { InvitationAcceptanceResult } from './identity-workspace-contracts.js';
import { InvitationAcceptanceConflictError } from './identity-workspace-errors.js';

/** Durable acceptance receipt stored on the intent and the command receipt. */
export const acceptanceReceiptSchema = z
  .object({
    intentId: z.uuid(),
    workspaceId: z.uuid(),
    role: z.enum(['owner', 'admin', 'builder', 'operator', 'viewer']),
    membershipCreated: z.boolean(),
  })
  .strict();

type AcceptanceReceipt = z.output<typeof acceptanceReceiptSchema>;

type AcceptanceReceiptRow = Readonly<{
  request_hash: string;
  status: string;
  result_ref: unknown;
}>;

/** Locks the accept-command receipt claimed by an actor's idempotency key. */
export async function lockAcceptanceReceipt(
  client: PoolClient,
  actorUserId: string,
  workspaceId: string,
  keyHash: string,
): Promise<AcceptanceReceiptRow | undefined> {
  const result = await client.query<AcceptanceReceiptRow>(
    `select request_hash,status,result_ref
       from app.workspace_invitation_command_receipts
      where actor_user_id=$1 and workspace_id=$2 and operation='accept' and key_hash=$3
      for update`,
    [actorUserId, workspaceId, keyHash],
  );
  return result.rows[0];
}

export function replayedAcceptance(
  receipt: AcceptanceReceipt,
): InvitationAcceptanceResult {
  return Object.freeze({
    ...receipt,
    replayed: true,
    replacementSessionCreated: false,
  });
}

/**
 * Replays a completed receipt of the same command. Another command reusing
 * the key is an idempotency conflict; an unfinished receipt is corrupt state.
 */
export function replayAcceptanceReceipt(
  row: AcceptanceReceiptRow | undefined,
  commandHash: string,
): InvitationAcceptanceResult {
  if (row?.request_hash !== commandHash)
    throw new InvitationAcceptanceConflictError(
      'idempotency_conflict',
      'The key belongs to another acceptance command',
    );
  const prior = acceptanceReceiptSchema.safeParse(row.result_ref);
  if (row.status !== 'completed' || !prior.success)
    throw new Error('Invitation acceptance receipt is incomplete');
  return replayedAcceptance(prior.data);
}

/**
 * Persists a completed acceptance: the invitation becomes accepted, its
 * delivery tokens are scrubbed, the intent and command receipt record the
 * durable receipt, and the acceptance is audited.
 */
export async function recordAcceptedInvitation(
  client: PoolClient,
  input: Readonly<{
    receiptId: string;
    receipt: AcceptanceReceipt;
    actorUserId: string;
    invitationId: string;
    invitationRevision: number;
    requestId: string | null;
    traceId: string | null;
  }>,
): Promise<void> {
  const { receipt, actorUserId, invitationId } = input;
  const receiptJson = JSON.stringify(receipt);
  await client.query(
    `update app.workspace_invitations
        set status='accepted',accepted_by=$3,accepted_at=clock_timestamp(),
            delivery_status='canceled',updated_at=clock_timestamp()
      where workspace_id=$1 and id=$2`,
    [receipt.workspaceId, invitationId, actorUserId],
  );
  await client.query(
    `update app.workspace_invitation_delivery_attempts
        set token_ciphertext=null,token_nonce=null,token_tag=null,token_key_version=null,
            status=case when status='queued' then 'canceled' else status end,
            updated_at=clock_timestamp()
      where workspace_id=$1 and invitation_id=$2`,
    [receipt.workspaceId, invitationId],
  );
  await client.query(
    `update app.workspace_invitation_acceptance_intents
        set status='completed',accepted_user_id=$3,receipt=$4::jsonb,
            completed_at=clock_timestamp(),updated_at=clock_timestamp()
      where workspace_id=$1 and id=$2`,
    [receipt.workspaceId, receipt.intentId, actorUserId, receiptJson],
  );
  await client.query(
    `insert into app.audit_events
       (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
     values($1,$2,$3,'workspace.invitation_accepted','workspace_invitation',$4,$5,$6,$7::jsonb)`,
    [
      generatePersistedId(),
      receipt.workspaceId,
      actorUserId,
      invitationId,
      input.requestId,
      input.traceId,
      JSON.stringify({
        invitationRevision: input.invitationRevision,
        membershipCreated: receipt.membershipCreated,
        role: receipt.role,
      }),
    ],
  );
  await client.query(
    `update app.workspace_invitation_command_receipts
        set status='completed',result_ref=$2::jsonb,updated_at=clock_timestamp()
      where id=$1 and status='in_progress'`,
    [input.receiptId, receiptJson],
  );
}
