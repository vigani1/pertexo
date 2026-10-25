import { decideInvitationAcceptance } from '@pertexo/workflow-model';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { readEligibleAuthenticationSession } from '../../../identity/federation/sessions/authority.repository.js';
import type { CommandIdentity } from '../../../platform/idempotency/contract.js';
import {
  claimCommand,
  completeCommand,
} from '../../../platform/idempotency/repository.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import {
  workspaceInvitationAcceptanceIntents as intents,
  workspaceInvitations as invitations,
  users,
  workspaceMemberships,
  workspaces,
} from '../../../schema/foundation.js';
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

import {
  createMemberships,
  updateMembership,
} from '../../members/records.repository.js';
import {
  withPlatformTransaction,
  withWorkspaceScope,
} from '../../transactions.js';
import { replaceUserSessions } from '../../users/sessions.repository.js';
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
        const receipt = {
          intentId,
          workspaceId,
          role: assignedRole,
          membershipCreated,
        };
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
      email: invitations.normalizedEmail,
      expiresAt: invitations.expiresAt,
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
  const decision = decideInvitationAcceptance({
    actorUserId,
    invitationRevision,
    intent,
    current: invitation[0],
    previewSessionId: preview.verifiedSessionId,
    sourceSession,
    userStatus,
    workspaceStatus,
    now: new Date(),
  });
  if (!decision.allowed)
    throw new InvitationAcceptanceConflictError(
      decision.reason,
      decision.message,
    );
  return decision;
}

function prepareAcceptance(raw: CompleteInvitationAcceptanceInput) {
  const workspaceId = raw.workspaceId;
  const intentId = raw.intentId;
  const actorUserId = raw.actorUserId;
  const invitationRevision = raw.invitationRevision;
  const command: CommandIdentity = {
    workspaceId,
    operation: 'workspace.invitation.accept',
    scope: actorUserId,
    idempotencyKey: raw.idempotencyKey,
  };
  return {
    identity: { workspaceId, intentId, actorUserId, invitationRevision },
    command,
  };
}
