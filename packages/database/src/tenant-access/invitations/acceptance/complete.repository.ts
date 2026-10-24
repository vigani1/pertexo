import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaceInvitationAcceptanceIntents as intents,
  workspaceInvitations as invitations,
  workspaces,
  users,
  workspaceMemberships,
} from '../../../schema/foundation.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { readEligibleAuthenticationSession } from '../../../identity/federation/sessions/authority.repository.js';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  claimCommand,
  completeCommand,
} from '../../../platform/idempotency/repository.js';
import type { CommandIdentity } from '../../../platform/idempotency/contract.js';
import type {
  CompleteInvitationAcceptanceInput,
  InvitationAcceptanceResult,
} from '../../contract.js';
import { InvitationAcceptanceConflictError } from '../../errors.js';
import {
  acceptanceReceiptSchema,
  recordAcceptedInvitation,
  replayedAcceptance,
} from '../receipts.repository.js';

import { replaceUserSessions } from '../../users/sessions.repository.js';
import {
  createMemberships,
  updateMembership,
} from '../../members/records.repository.js';
import { parseIdentityUuid } from '../../support.js';
import {
  withPlatformTransaction,
  withWorkspaceScope,
} from '../../transactions.js';
import { key } from './input.js';
import { selectIntent } from './state.queries.js';

export async function completeAcceptance(
  pool: Pool,
  raw: CompleteInvitationAcceptanceInput,
): Promise<InvitationAcceptanceResult> {
  const { identity, command } = prepareAcceptance(raw);
  const { workspaceId, intentId, actorUserId, invitationRevision } = identity;
  return withPlatformTransaction(pool, async (client) => {
    const preview = await withWorkspaceScope(
      client,
      { workspaceId, actorId: actorUserId },
      (scoped) => selectIntent(scoped, eq(intents.id, intentId)),
    );
    if (preview === null)
      throw new InvitationAcceptanceConflictError(
        'unavailable',
        'The invitation journey is unavailable',
      );
    const db = drizzle(client);
    const workspace = await db
      .select({ status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for('update')
      .catch(rethrowQueryFailure);
    const user = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, actorUserId))
      .for('update')
      .catch(rethrowQueryFailure);
    const sourceSession =
      preview.verifiedSessionId === null
        ? undefined
        : await readEligibleAuthenticationSession(
            client,
            preview.verifiedSessionId,
          );
    return withWorkspaceScope(
      client,
      { workspaceId, actorId: actorUserId },
      async (client) => {
        const state = await readScopedAcceptance(client, {
          ...identity,
          preview,
        });
        const { membership, intent } = state;
        const stored = await claimCommand(client, {
          ...command,
          request: { intentId, invitationRevision },
          resourceId: intentId,
        });
        if (stored !== null)
          return replayedAcceptance(acceptanceReceiptSchema.parse(stored));
        if (intent.status === 'completed') {
          if (intent.acceptedUserId !== actorUserId || intent.receipt === null)
            throw new InvitationAcceptanceConflictError(
              'unavailable',
              'The invitation receipt is unavailable',
            );
          await completeCommand(client, command, intent.receipt);
          return replayedAcceptance(intent.receipt);
        }
        const { current, sourceSession: verifiedSession } =
          requireAcceptanceProof(identity, {
            ...state,
            preview,
            sourceSession,
            userStatus: user[0]?.status,
            workspaceStatus: workspace[0]?.status,
          });
        const existing = membership[0];
        // ADR 042: a removal ends the membership, so a later invitation starts
        // a new one at the invited role. Suspension stays a conflict.
        const rejoining = existing?.status === 'removed';
        const membershipUnavailable =
          existing !== undefined && existing.status !== 'active' && !rejoining;
        if (membershipUnavailable)
          throw new InvitationAcceptanceConflictError(
            'member_inactive',
            'Inactive membership cannot be restored by invitation',
          );
        const membershipCreated = existing === undefined || rejoining;
        const assignedRole = membershipCreated ? current.role : existing.role;
        if (membershipCreated) {
          if (existing === undefined)
            await createMemberships(
              client,
              workspaceId,
              [
                {
                  userId: actorUserId,
                  role: assignedRole,
                  source: 'invitation',
                  invitationId: intent.invitationId,
                },
              ],
              {
                actorId: actorUserId,
                requestId: raw.requestId ?? null,
                traceId: raw.traceId ?? null,
              },
            );
          else
            await updateMembership(client, workspaceId, {
              userId: actorUserId,
              role: assignedRole,
              status: 'active',
              roleRevision: existing.role_revision + 1,
            });
          await replaceUserSessions(
            client,
            actorUserId,
            raw.replacementSession,
            verifiedSession.proof,
          );
        }
        const receipt = acceptanceReceiptSchema.parse({
          intentId,
          workspaceId,
          role: assignedRole,
          membershipCreated,
        });
        await recordAcceptedInvitation(client, {
          command,
          receipt,
          actorUserId,
          invitationId: intent.invitationId,
          invitationRevision,
          requestId: raw.requestId ?? null,
          traceId: raw.traceId ?? null,
        });
        return Object.freeze({
          ...receipt,
          replayed: false,
          replacementSessionCreated: membershipCreated,
        });
      },
    );
  });
}

type AcceptanceIdentity = Readonly<{
  workspaceId: string;
  intentId: string;
  actorUserId: string;
  invitationRevision: number;
}>;
async function readScopedAcceptance(
  client: PoolClient,
  {
    workspaceId,
    intentId,
    actorUserId,
    preview,
  }: AcceptanceIdentity &
    Readonly<{
      preview: NonNullable<Awaited<ReturnType<typeof selectIntent>>>;
    }>,
) {
  const db = drizzle(client);
  const membership = await db
    .select({
      role: workspaceMemberships.role,
      status: workspaceMemberships.status,
      role_revision: workspaceMemberships.roleRevision,
    })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, actorUserId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const invitation = await db
    .select({
      status: invitations.status,
      revision: invitations.revision,
      role: invitations.role,
      normalized_email: invitations.normalizedEmail,
      expires_at: invitations.expiresAt,
    })
    .from(invitations)
    .where(
      and(
        eq(invitations.workspaceId, workspaceId),
        eq(invitations.id, preview.invitationId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const intent = await selectIntent(client, eq(intents.id, intentId), {
    lock: true,
  });
  if (intent === null)
    throw new InvitationAcceptanceConflictError(
      'unavailable',
      'The invitation journey is unavailable',
    );

  return { membership, invitation, intent };
}
function requireAcceptanceProof(
  { actorUserId, invitationRevision }: AcceptanceIdentity,
  {
    intent,
    invitation,
    preview,
    sourceSession,
    userStatus,
    workspaceStatus,
  }: Awaited<ReturnType<typeof readScopedAcceptance>> &
    Readonly<{
      preview: NonNullable<Awaited<ReturnType<typeof selectIntent>>>;
      sourceSession: Awaited<
        ReturnType<typeof readEligibleAuthenticationSession>
      >;
      userStatus: string | undefined;
      workspaceStatus: string | undefined;
    }>,
) {
  if (userStatus !== 'active')
    throw new InvitationAcceptanceConflictError(
      'member_inactive',
      'The accepting user is not active',
    );
  const now = new Date();
  if (intent.expiresAt.getTime() <= now.getTime())
    throw new InvitationAcceptanceConflictError(
      'expired',
      'The invitation journey expired',
    );
  if (intent.status === 'superseded')
    throw new InvitationAcceptanceConflictError(
      'superseded',
      'The invitation journey was superseded',
    );
  const verificationUnavailable =
    sourceSession?.userId !== actorUserId ||
    intent.verifiedSessionId !== preview.verifiedSessionId ||
    intent.status !== 'verified' ||
    intent.verifiedUserId !== actorUserId ||
    intent.verifiedAt === null ||
    now.getTime() - intent.verifiedAt.getTime() > 5 * 60_000;
  if (verificationUnavailable)
    throw new InvitationAcceptanceConflictError(
      'proof_expired',
      'Fresh recipient verification is required',
    );
  if (intent.invitationRevision !== invitationRevision)
    throw new InvitationAcceptanceConflictError(
      'revision_conflict',
      'The invitation changed',
    );
  if (workspaceStatus !== 'active')
    throw new InvitationAcceptanceConflictError(
      'workspace_inactive',
      'The workspace is not active',
    );
  const current = invitation[0];
  const invitationUnavailable =
    current?.status !== 'pending' ||
    current.expires_at.getTime() <= now.getTime() ||
    current.revision !== invitationRevision;
  if (invitationUnavailable)
    throw new InvitationAcceptanceConflictError(
      'superseded',
      'The invitation is no longer pending',
    );
  if (current.normalized_email !== intent.verifiedEmail)
    throw new InvitationAcceptanceConflictError(
      'recipient_mismatch',
      'The verified recipient does not match',
    );

  return { current, sourceSession };
}

function prepareAcceptance(raw: CompleteInvitationAcceptanceInput) {
  const workspaceId = parseIdentityUuid(raw.workspaceId);
  const intentId = parseIdentityUuid(raw.intentId);
  const actorUserId = parseIdentityUuid(raw.actorUserId);
  const invitationRevision = z
    .number()
    .int()
    .positive()
    .parse(raw.invitationRevision);
  const command: CommandIdentity = {
    workspaceId,
    operation: 'workspace.invitation.accept',
    scope: actorUserId,
    idempotencyKey: key.parse(raw.idempotencyKey),
  };
  return {
    identity: { workspaceId, intentId, actorUserId, invitationRevision },
    command,
  };
}
