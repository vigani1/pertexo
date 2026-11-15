import { readDatabaseClock } from '../../../shared/database-clock.repository.js';
import type { Pool, PoolClient } from 'pg';
import { withTenantScopedClient } from '@pertexo/database/primitives';

import { canInviteWorkspaceRole } from '@pertexo/policy';
import { generatePersistedId } from '@pertexo/database/platform';
import type {
  ResendWorkspaceInvitationInput,
  RevokeWorkspaceInvitationInput,
  WorkspaceInvitationCommandResult,
} from '../../tenant-access.types.js';
import { WorkspaceInvitationCommandConflictError } from '../../tenant-access.errors.js';
import { cancelOpenInvitationDeliveries } from '../delivery-cancellation.repository.js';
import { expireWorkspaceInvitations } from '../expiration.repository.js';
import { supersedeOpenIntents } from '../open-intents.repository.js';
import {
  claimInvitationCommand,
  completeInvitationCommand,
  insertDelivery,
  invitationKey,
  recordAudit,
} from './receipts.repository.js';
import { lockAuthorizedActor } from './lock-authorized-actor.js';
import {
  lockInvitation,
  lockLatestDeliveryStatus,
  updateInvitation,
} from './commands.repository.js';

/** What a new delivery of the invitation needs; a revocation has none. */
type NextDelivery = Readonly<{
  tokenDigest: string;
  sealed: ResendWorkspaceInvitationInput['sealedToken'];
  deliveryAttemptId: string;
}>;

export function resendInvitation(
  pool: Pool,
  raw: ResendWorkspaceInvitationInput,
): Promise<WorkspaceInvitationCommandResult> {
  return changeInvitation(pool, raw, 'resend', {
    tokenDigest: raw.tokenDigest,
    sealed: raw.sealedToken,
    deliveryAttemptId: raw.deliveryAttemptId ?? generatePersistedId(),
  });
}

export function revokeInvitation(
  pool: Pool,
  raw: RevokeWorkspaceInvitationInput,
): Promise<WorkspaceInvitationCommandResult> {
  return changeInvitation(pool, raw, 'revoke', undefined);
}

async function changeInvitation(
  pool: Pool,
  raw: RevokeWorkspaceInvitationInput,
  operation: 'resend' | 'revoke',
  nextDelivery: NextDelivery | undefined,
): Promise<WorkspaceInvitationCommandResult> {
  const { workspaceId, actorUserId, invitationId, expectedRevision } = raw;
  const result = await withTenantScopedClient(
    pool,
    { workspaceId, actorId: actorUserId },
    async (client) => {
      const actorRole = await lockAuthorizedActor(
        client,
        workspaceId,
        actorUserId,
      );
      const current = await lockInvitation(client, {
        workspaceId,
        invitationId,
      });
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
      const now = await readDatabaseClock(client);
      if (
        current.status === 'pending' &&
        current.expiresAt.getTime() <= now.getTime()
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
      const mutationTime = await readDatabaseClock(client);
      if (current.expiresAt.getTime() <= mutationTime.getTime())
        throw new WorkspaceInvitationCommandConflictError(
          'invitation_inactive',
          'The invitation has expired',
        );
      const invitation = await updateInvitation(
        client,
        { workspaceId, invitationId },
        {
          operation,
          nextRevision,
          tokenDigest: nextDelivery?.tokenDigest,
          mutationTime,
        },
      );
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

async function requireSettledDelivery(
  client: PoolClient,
  workspaceId: string,
  invitationId: string,
  revision: number,
): Promise<void> {
  const status = await lockLatestDeliveryStatus(
    client,
    workspaceId,
    invitationId,
    revision,
  );
  if (status !== undefined && ['queued', 'unknown'].includes(status))
    throw new WorkspaceInvitationCommandConflictError(
      'delivery_unresolved',
      status === 'unknown'
        ? 'Email delivery could not be confirmed. Revoke this invitation and create a new one to send another link.'
        : 'The last email is still being delivered. Wait a minute before sending a new link.',
    );
}

async function retireInvitationEvidence(
  client: PoolClient,
  workspaceId: string,
  invitationId: string,
): Promise<void> {
  await supersedeOpenIntents(client, workspaceId, invitationId);
  await cancelOpenInvitationDeliveries(client, workspaceId, invitationId);
}
