import type { PoolClient } from 'pg';
import { z } from 'zod';

import {
  completeCommand,
  type CommandIdentity,
} from '../../platform/idempotency.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import type { InvitationAcceptanceResult } from '../contracts.js';

/** Durable acceptance receipt stored on the intent and as the command's result. */
export const acceptanceReceiptSchema = z
  .object({
    intentId: z.uuid(),
    workspaceId: z.uuid(),
    role: z.enum(['owner', 'admin', 'builder', 'operator', 'viewer']),
    membershipCreated: z.boolean(),
  })
  .strict();

type AcceptanceReceipt = z.output<typeof acceptanceReceiptSchema>;

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
 * Persists a completed acceptance: the invitation becomes accepted, its
 * delivery tokens are scrubbed, the intent and the command's key record the
 * durable receipt, and the acceptance is audited.
 */
export async function recordAcceptedInvitation(
  client: PoolClient,
  input: Readonly<{
    command: CommandIdentity;
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
  await completeCommand(client, input.command, receipt);
}
