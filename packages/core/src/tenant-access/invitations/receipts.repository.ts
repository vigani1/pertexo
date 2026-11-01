import {
  appendAuditFact,
  rethrowQueryFailure,
  completeCommand,
} from '@pertexo/database/primitives';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaceInvitations as invitations,
  workspaceInvitationDeliveryAttempts as attempts,
  workspaceInvitationAcceptanceIntents as intents,
} from '@pertexo/database/schema';
import { ROLES } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { CommandIdentity } from '@pertexo/database/primitives';
import type { InvitationAcceptanceResult } from '../contract.js';

/** Durable acceptance receipt stored on the intent and as the command's result. */
export const acceptanceReceiptSchema = z
  .object({
    intentId: z.uuid(),
    workspaceId: z.uuid(),
    role: z.enum(ROLES),
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
  const db = drizzle(client);
  await db
    .update(invitations)
    .set({
      status: 'accepted',
      acceptedBy: actorUserId,
      acceptedAt: sql`clock_timestamp()`,
      deliveryStatus: 'canceled',
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(invitations.workspaceId, receipt.workspaceId),
        eq(invitations.id, invitationId),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .update(attempts)
    .set({
      tokenCiphertext: null,
      tokenNonce: null,
      tokenTag: null,
      tokenKeyVersion: null,
      status: sql`case when ${attempts.status}='queued' then 'canceled' else ${attempts.status} end`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(attempts.workspaceId, receipt.workspaceId),
        eq(attempts.invitationId, invitationId),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .update(intents)
    .set({
      status: 'completed',
      acceptedUserId: actorUserId,
      receipt,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(intents.workspaceId, receipt.workspaceId),
        eq(intents.id, receipt.intentId),
      ),
    )
    .catch(rethrowQueryFailure);
  await appendAuditFact(client, {
    workspaceId: receipt.workspaceId,
    actorId: actorUserId,
    action: 'workspace.invitation_accepted',
    targetType: 'workspace_invitation',
    targetId: invitationId,
    requestId: input.requestId,
    traceId: input.traceId,
    metadata: {
      invitationRevision: input.invitationRevision,
      membershipCreated: receipt.membershipCreated,
      role: receipt.role,
    },
  });
  await completeCommand(client, input.command, receipt);
}
