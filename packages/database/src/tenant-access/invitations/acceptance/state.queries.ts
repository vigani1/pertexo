import { installTransactionScope } from '../../transactions/scope.js';
import { and, eq, getTableName, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type { InvitationAcceptanceIntentRecord } from '../../contract.js';
import {
  workspaceInvitationAcceptanceIntents as intents,
  workspaceInvitations as invitations,
  workspaces,
  workspaceInvitationBindingReplacementClaims as claims,
} from '../../../schema/foundation.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { acceptanceReceiptSchema } from '../receipts.repository.js';

export async function selectIntent(
  client: PoolClient,
  predicate: SQL,
  { lock = false }: Readonly<{ lock?: boolean | undefined }> = {},
): Promise<InvitationAcceptanceIntentRecord | null> {
  const query = drizzle(client)
    .select({
      id: intents.id,
      workspaceId: intents.workspaceId,
      invitationId: intents.invitationId,
      invitationRevision: intents.invitationRevision,
      status: intents.status,
      expiresAt: intents.expiresAt,
      verifiedUserId: intents.verifiedUserId,
      verifiedSessionId: intents.verifiedSessionId,
      verifiedEmail: intents.verifiedEmail,
      verifiedAt: intents.verifiedAt,
      acceptedUserId: intents.acceptedUserId,
      receipt: intents.receipt,
      workspaceName: workspaces.name,
      invitationRole: invitations.role,
      invitationStatus: invitations.status,
    })
    .from(intents)
    .leftJoin(invitations, eq(invitations.id, intents.invitationId))
    .leftJoin(workspaces, eq(workspaces.id, intents.workspaceId))
    .where(predicate);
  const rows = await (
    lock
      ? query.for('update', { of: alias(intents, getTableName(intents)) })
      : query
  ).catch(rethrowQueryFailure);
  const row = rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    ...row,
    receipt:
      row.receipt === null ? null : acceptanceReceiptSchema.parse(row.receipt),
  });
}

export function selectReplacementClaim(
  client: PoolClient,
  prior: Readonly<{
    workspaceId: string;
    intentId: string;
    bindingDigest: string;
  }>,
  { lock = false }: Readonly<{ lock?: boolean }> = {},
) {
  const query = drizzle(client)
    .select({
      successor_workspace_id: claims.successorWorkspaceId,
      successor_intent_id: claims.successorIntentId,
      successor_invitation_id: claims.successorInvitationId,
      successor_invitation_revision: claims.successorInvitationRevision,
      successor_binding_digest: claims.successorBindingDigest,
      successor_csrf_digest: claims.successorCsrfDigest,
    })
    .from(claims)
    .where(
      and(
        eq(claims.priorWorkspaceId, prior.workspaceId),
        eq(claims.priorIntentId, prior.intentId),
        eq(claims.priorBindingDigest, prior.bindingDigest),
      ),
    );
  return (lock ? query.for('update') : query).catch(rethrowQueryFailure);
}
export type ReplacementClaimRow = Awaited<
  ReturnType<typeof selectReplacementClaim>
>[number];

export function selectReplacementIntent(
  client: PoolClient,
  workspaceId: string,
  intentId: string,
) {
  return drizzle(client)
    .select({
      id: intents.id,
      invitation_id: intents.invitationId,
      invitation_revision: intents.invitationRevision,
      binding_digest: intents.bindingDigest,
      csrf_digest: intents.csrfDigest,
      status: intents.status,
      expires_at: intents.expiresAt,
    })
    .from(intents)
    .where(and(eq(intents.workspaceId, workspaceId), eq(intents.id, intentId)))
    .for('update')
    .catch(rethrowQueryFailure);
}
export type ReplacementIntentRow = Awaited<
  ReturnType<typeof selectReplacementIntent>
>[number];

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
    const claimResult = await selectReplacementClaim(client, current);
    const claim = claimResult[0];
    if (claim === undefined) return false;
    await installTransactionScope(client, {
      workspaceId: claim.successor_workspace_id,
    });
    const intentResult = await selectReplacementIntent(
      client,
      claim.successor_workspace_id,
      claim.successor_intent_id,
    );
    current = {
      workspaceId: claim.successor_workspace_id,
      intentId: claim.successor_intent_id,
      bindingDigest: claim.successor_binding_digest,
      intent: intentResult[0],
    };
  }
  return true;
}
