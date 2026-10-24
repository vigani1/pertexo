import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workspaceInvitations as invitations } from '../../../schema/foundation.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { Pool } from 'pg';

import { generatePersistedId } from '../../../platform/persisted-id.js';

import { WorkspaceInvitationCommandConflictError } from '../../errors.js';

import { expireWorkspaceInvitations } from '../expiration.repository.js';
import {
  parseIdentityUuid,
  readIdentityDatabaseErrorCode,
} from '../../support.js';
import { canInviteWorkspaceRole } from '@pertexo/workflow-model';
import { withTenantScopedClient } from '../../transactions.js';
import type { InvitationStore } from './contract.js';
import { delegatedRole, digest, sealedToken } from '../input.js';
import { normalizeEmail } from '../input.js';
import { lockAuthorizedActor, invitationSelection } from './state.queries.js';
import {
  invitationKey,
  claimInvitationCommand,
  completeInvitationCommand,
  insertDelivery,
  recordAudit,
} from './receipts.repository.js';

export async function createWorkspaceInvitation(
  pool: Pool,
  raw: Parameters<InvitationStore['createWorkspaceInvitation']>[0],
): ReturnType<InvitationStore['createWorkspaceInvitation']> {
  const workspaceId = parseIdentityUuid(raw.workspaceId);
  const actorUserId = parseIdentityUuid(raw.actorUserId);
  const invitationId = parseIdentityUuid(
    raw.invitationId ?? generatePersistedId(),
  );
  const deliveryAttemptId = parseIdentityUuid(
    raw.deliveryAttemptId ?? generatePersistedId(),
  );
  const email = normalizeEmail(raw.email);
  const role = delegatedRole.parse(raw.role);
  const tokenDigest = digest.parse(raw.tokenDigest);
  const sealed = sealedToken.parse(raw.sealedToken);
  if (!(raw.expiresAt instanceof Date) || raw.expiresAt.getTime() <= Date.now())
    throw new Error('Invitation expiry must be in the future');
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
      const db = drizzle(client);
      const duplicate = await db
        .select({ one: sql`1` })
        .from(invitations)
        .where(
          and(
            eq(invitations.workspaceId, workspaceId),
            eq(invitations.normalizedEmail, email),
            eq(invitations.status, 'pending'),
          ),
        )
        .for('update')
        .catch(rethrowQueryFailure);
      if (duplicate.length > 0)
        throw new WorkspaceInvitationCommandConflictError(
          'duplicate_pending',
          'A pending invitation already exists for this recipient',
        );
      let inserted;
      try {
        inserted = await db
          .insert(invitations)
          .values({
            id: invitationId,
            workspaceId,
            recipientEmail: email,
            normalizedEmail: email,
            role,
            status: 'pending',
            revision: 1,
            tokenDigest,
            deliveryStatus: 'queued',
            createdBy: actorUserId,
            expiresAt: raw.expiresAt,
          })
          .returning(invitationSelection)
          .catch(rethrowQueryFailure);
      } catch (error: unknown) {
        if (readIdentityDatabaseErrorCode(error) === '23505')
          throw new WorkspaceInvitationCommandConflictError(
            'duplicate_pending',
            'A pending invitation already exists for this recipient',
            { cause: error },
          );
        throw error;
      }
      const insertedInvitation = inserted[0];
      if (insertedInvitation === undefined)
        throw new Error('Invitation insert returned no row');
      const invitation = Object.freeze(insertedInvitation);
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
