import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaceInvitations as invitations,
  workspaceInvitationDeliveryAttempts as attempts,
  workspaceInvitationAcceptanceIntents as intents,
} from '../../../schema/foundation.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { generatePersistedId } from '../../../platform/persisted-id.js';
import type {
  ChangeWorkspaceInvitationInput,
  WorkspaceInvitationCommandResult,
} from '../../contract.js';
import { WorkspaceInvitationCommandConflictError } from '../../errors.js';
import { cancelOpenInvitationDeliveries } from '../delivery-cancellation.repository.js';
import { expireWorkspaceInvitations } from '../expiration.repository.js';
import { parseIdentityUuid } from '../../support.js';
import { canInviteWorkspaceRole } from '@pertexo/workflow-model';
import { withTenantScopedClient } from '../../transactions.js';
import { revision, digest, sealedToken } from '../input.js';
import { lockAuthorizedActor, invitationSelection } from './state.queries.js';
import {
  invitationKey,
  claimInvitationCommand,
  completeInvitationCommand,
  insertDelivery,
  recordAudit,
} from './receipts.repository.js';

export async function changeInvitation(
  pool: Pool,
  raw: ChangeWorkspaceInvitationInput,
  operation: 'resend' | 'revoke',
): Promise<WorkspaceInvitationCommandResult> {
  const {
    workspaceId,
    actorUserId,
    invitationId,
    expectedRevision,
    nextDelivery,
  } = prepareInvitationChange(raw, operation);
  const result = await withTenantScopedClient(
    pool,
    { workspaceId, actorId: actorUserId },
    async (client) => {
      const actorRole = await lockAuthorizedActor(
        client,
        workspaceId,
        actorUserId,
      );
      const db = drizzle(client);
      const locked = await db
        .select(invitationSelection)
        .from(invitations)
        .where(
          and(
            eq(invitations.workspaceId, workspaceId),
            eq(invitations.id, invitationId),
          ),
        )
        .for('update')
        .catch(rethrowQueryFailure);
      const current = locked[0];
      if (current === undefined)
        throw new WorkspaceInvitationCommandConflictError(
          'invitation_missing',
          'The invitation was not found',
        );
      if (!canInviteWorkspaceRole(actorRole, current.role))
        throw new WorkspaceInvitationCommandConflictError(
          'role_forbidden',
          'The actor cannot manage this invitation',
        );
      if (
        current.status === 'pending' &&
        current.expiresAt.getTime() <= Date.now()
      ) {
        await expireWorkspaceInvitations(client, { workspaceId, invitationId });
        return { expired: true } as const;
      }
      const key = invitationKey(
        workspaceId,
        actorUserId,
        operation,
        raw.idempotencyKey,
      );
      const replay = await claimInvitationCommand(
        client,
        key,
        { invitationId, expectedRevision },
        invitationId,
      );
      if (replay !== null) return replay;
      if (current.status !== 'pending')
        throw new WorkspaceInvitationCommandConflictError(
          'invitation_inactive',
          'Only a pending invitation can be changed',
        );
      if (current.revision !== expectedRevision)
        throw new WorkspaceInvitationCommandConflictError(
          'revision_conflict',
          'The invitation changed since it was loaded',
        );
      if (operation === 'resend')
        await requireSettledDelivery(
          client,
          workspaceId,
          invitationId,
          current.revision,
        );
      const nextRevision = current.revision + 1;
      await retireInvitationEvidence(client, workspaceId, invitationId);
      const updated = await db
        .update(invitations)
        .set(
          operation === 'resend'
            ? {
                revision: nextRevision,
                tokenDigest: nextDelivery?.tokenDigest,
                expiresAt: nextDelivery?.expiresAt,
                deliveryStatus: 'queued',
                updatedAt: sql`clock_timestamp()`,
              }
            : {
                revision: nextRevision,
                status: 'revoked',
                revokedAt: sql`clock_timestamp()`,
                deliveryStatus: 'canceled',
                updatedAt: sql`clock_timestamp()`,
              },
        )
        .where(
          and(
            eq(invitations.workspaceId, workspaceId),
            eq(invitations.id, invitationId),
          ),
        )
        .returning(invitationSelection)
        .catch(rethrowQueryFailure);
      const updatedInvitation = updated[0];
      if (updatedInvitation === undefined)
        throw new Error('Invitation update returned no row');
      const invitation = Object.freeze(updatedInvitation);
      if (nextDelivery !== undefined)
        await insertDelivery(client, {
          workspaceId,
          invitationId,
          revision: nextRevision,
          deliveryAttemptId: nextDelivery.deliveryAttemptId,
          sealed: nextDelivery.sealed,
        });
      await recordAudit(client, {
        workspaceId,
        actorUserId,
        invitationId,
        action:
          operation === 'resend'
            ? 'workspace.invitation_resent'
            : 'workspace.invitation_revoked',
        revision: nextRevision,
        role: invitation.role,
        ...(raw.requestId === undefined ? {} : { requestId: raw.requestId }),
        ...(raw.traceId === undefined ? {} : { traceId: raw.traceId }),
      });
      return completeInvitationCommand(client, key, invitation);
    },
  );
  if ('expired' in result)
    throw new WorkspaceInvitationCommandConflictError(
      'invitation_inactive',
      'The invitation has expired',
    );
  return result;
}

function prepareInvitationChange(
  raw: ChangeWorkspaceInvitationInput,
  operation: 'resend' | 'revoke',
) {
  const workspaceId = parseIdentityUuid(raw.workspaceId);
  const actorUserId = parseIdentityUuid(raw.actorUserId);
  const invitationId = parseIdentityUuid(raw.invitationId);
  const expectedRevision = revision.parse(raw.expectedRevision);
  const nextDelivery =
    operation === 'resend'
      ? {
          tokenDigest: digest.parse(raw.tokenDigest),
          sealed: sealedToken.parse(raw.sealedToken),
          deliveryAttemptId: parseIdentityUuid(
            raw.deliveryAttemptId ?? generatePersistedId(),
          ),
          expiresAt: z.date().parse(raw.expiresAt),
        }
      : undefined;

  return {
    workspaceId,
    actorUserId,
    invitationId,
    expectedRevision,
    nextDelivery,
  };
}

async function requireSettledDelivery(
  client: PoolClient,
  workspaceId: string,
  invitationId: string,
  revision: number,
): Promise<void> {
  const delivery = await drizzle(client)
    .select({ status: attempts.status })
    .from(attempts)
    .where(
      and(
        eq(attempts.workspaceId, workspaceId),
        eq(attempts.invitationId, invitationId),
        eq(attempts.invitationRevision, revision),
      ),
    )
    .orderBy(desc(attempts.createdAt), desc(attempts.id))
    .limit(1)
    .for('update')
    .catch(rethrowQueryFailure);
  if (
    delivery[0] !== undefined &&
    ['queued', 'unknown'].includes(delivery[0].status)
  )
    throw new WorkspaceInvitationCommandConflictError(
      'delivery_unresolved',
      'The prior delivery outcome must be reconciled before resending',
    );
}

async function retireInvitationEvidence(
  client: PoolClient,
  workspaceId: string,
  invitationId: string,
): Promise<void> {
  const db = drizzle(client);
  await db
    .update(intents)
    .set({ status: 'superseded', updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(intents.workspaceId, workspaceId),
        eq(intents.invitationId, invitationId),
        inArray(intents.status, ['pending', 'verified', 'wrong_account']),
      ),
    )
    .catch(rethrowQueryFailure);
  await cancelOpenInvitationDeliveries(client, workspaceId, invitationId);
}
