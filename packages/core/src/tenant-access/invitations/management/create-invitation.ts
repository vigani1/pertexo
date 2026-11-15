import { INVITATION_TTL_MILLIS } from '../deadlines.js';
import { readDatabaseClock } from '../../../shared/database-clock.repository.js';
import type { Pool } from 'pg';
import { withTenantScopedClient } from '@pertexo/database/primitives';

import { generatePersistedId } from '@pertexo/database/platform';

import { WorkspaceInvitationCommandConflictError } from '../../tenant-access.errors.js';

import { canInviteWorkspaceRole } from '@pertexo/policy';
import { canonicalEmail } from '../../../identity/email-policy.js';
import { expireWorkspaceInvitations } from '../expiration.repository.js';
import type {
  CreateWorkspaceInvitationInput,
  WorkspaceInvitationCommandResult,
} from '../../tenant-access.types.js';
import {
  claimInvitationCommand,
  completeInvitationCommand,
  insertDelivery,
  invitationKey,
  recordAudit,
} from './receipts.repository.js';
import {
  insertInvitation,
  lockPendingInvitation,
} from './create.repository.js';
import { lockAuthorizedActor } from './lock-authorized-actor.js';

export async function createWorkspaceInvitation(
  pool: Pool,
  raw: CreateWorkspaceInvitationInput,
): Promise<WorkspaceInvitationCommandResult> {
  const workspaceId = raw.workspaceId;
  const actorUserId = raw.actorUserId;
  const invitationId = raw.invitationId ?? generatePersistedId();
  const deliveryAttemptId = raw.deliveryAttemptId ?? generatePersistedId();
  const email = canonicalEmail(raw.email);
  const role = raw.role;
  const tokenDigest = raw.tokenDigest;
  const sealed = raw.sealedToken;
  return withTenantScopedClient(
    pool,
    { workspaceId, actorId: actorUserId },
    async (client) => {
      const actorRole = await lockAuthorizedActor(
        client,
        workspaceId,
        actorUserId,
      );
      if (!canInviteWorkspaceRole(actorRole, role))
        throw new WorkspaceInvitationCommandConflictError(
          'role_forbidden',
          'The actor cannot assign this invitation role',
        );
      await expireWorkspaceInvitations(client, {
        workspaceId,
        normalizedEmail: email,
      });
      const key = invitationKey(
        workspaceId,
        actorUserId,
        'create',
        raw.idempotencyKey,
      );
      const replay = await claimInvitationCommand(
        client,
        key,
        { email, role },
        invitationId,
      );
      if (replay !== null) return replay;
      if (await lockPendingInvitation(client, workspaceId, email))
        throw new WorkspaceInvitationCommandConflictError(
          'duplicate_pending',
          'A pending invitation already exists for this recipient',
        );
      const expiresAt = new Date(
        (await readDatabaseClock(client)).getTime() + INVITATION_TTL_MILLIS,
      );
      const inserted = await insertInvitation(client, {
        invitationId,
        workspaceId,
        email,
        role,
        tokenDigest,
        actorUserId,
        expiresAt,
      });
      if (inserted.kind === 'duplicate')
        throw new WorkspaceInvitationCommandConflictError(
          'duplicate_pending',
          'A pending invitation already exists for this recipient',
          { cause: inserted.cause },
        );
      const { invitation } = inserted;
      await insertDelivery(client, {
        workspaceId,
        invitationId,
        revision: 1,
        deliveryAttemptId,
        sealed,
      });
      await recordAudit(client, {
        workspaceId,
        actorUserId,
        invitationId,
        action: 'workspace.invitation_created',
        revision: 1,
        role,
        ...(raw.requestId === undefined ? {} : { requestId: raw.requestId }),
        ...(raw.traceId === undefined ? {} : { traceId: raw.traceId }),
      });
      return completeInvitationCommand(client, key, invitation);
    },
  );
}
