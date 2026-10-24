import type { Pool } from 'pg';
import { z } from 'zod';

import { generatePersistedId } from '../../platform/persisted-id.js';
import type {
  ChangeWorkspaceInvitationInput,
  CreateWorkspaceInvitationInput,
  WorkspaceInvitationCommandResult,
} from '../contract.js';
import { WorkspaceInvitationCommandConflictError } from '../errors.js';
import { cancelOpenInvitationDeliveries } from './delivery-cancellation.repository.js';
import { expireWorkspaceInvitations } from './expiration.repository.js';
import {
  parseIdentityUuid,
  readIdentityDatabaseErrorCode,
} from '../support.js';
import { canInviteWorkspaceRole } from '@pertexo/workflow-model';
import { withTenantScopedClient } from '../transactions.js';
import {
  type InvitationStore,
  delegatedRole,
  revision,
  digest,
  sealedToken,
  type InvitationRow,
} from './management/contract.js';
import {
  normalizeEmail,
  mapInvitation,
  lockAuthorizedActor,
  invitationSelection,
} from './management/state.queries.js';
import {
  invitationKey,
  claimInvitationCommand,
  completeInvitationCommand,
  insertDelivery,
  recordAudit,
} from './management/receipts.repository.js';

export function createIdentityWorkspaceInvitationStore(
  pool: Pool,
): InvitationStore {
  return Object.freeze({
    listWorkspaceInvitations: (workspaceIdInput, actorIdInput, input = {}) =>
      listWorkspaceInvitations(pool, workspaceIdInput, actorIdInput, input),

    createWorkspaceInvitation: (raw: CreateWorkspaceInvitationInput) =>
      createWorkspaceInvitation(pool, raw),

    resendWorkspaceInvitation: async (raw: ChangeWorkspaceInvitationInput) =>
      changeInvitation(pool, raw, 'resend'),
    revokeWorkspaceInvitation: async (raw: ChangeWorkspaceInvitationInput) =>
      changeInvitation(pool, raw, 'revoke'),
  });
}

async function changeInvitation(
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
      const locked = await client.query<InvitationRow>(
        `select ${invitationSelection} from app.workspace_invitations
          where workspace_id=$1 and id=$2 for update`,
        [workspaceId, invitationId],
      );
      const current = locked.rows[0];
      if (current === undefined)
        throw new WorkspaceInvitationCommandConflictError(
          'invitation_missing',
          'The invitation was not found',
        );
      if (!canInviteWorkspaceRole(actorRole, delegatedRole.parse(current.role)))
        throw new WorkspaceInvitationCommandConflictError(
          'role_forbidden',
          'The actor cannot manage this invitation',
        );
      if (
        current.status === 'pending' &&
        current.expires_at.getTime() <= Date.now()
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
      if (operation === 'resend') {
        const delivery = await client.query<{ status: string }>(
          `select status from app.workspace_invitation_delivery_attempts
            where workspace_id=$1 and invitation_id=$2 and invitation_revision=$3
            order by created_at desc,id desc limit 1 for update`,
          [workspaceId, invitationId, current.revision],
        );
        if (
          delivery.rows[0] !== undefined &&
          ['queued', 'unknown'].includes(delivery.rows[0].status)
        )
          throw new WorkspaceInvitationCommandConflictError(
            'delivery_unresolved',
            'The prior delivery outcome must be reconciled before resending',
          );
      }
      const nextRevision = current.revision + 1;
      await client.query(
        `update app.workspace_invitation_acceptance_intents
            set status='superseded',updated_at=clock_timestamp()
          where workspace_id=$1 and invitation_id=$2 and status in ('pending','verified','wrong_account')`,
        [workspaceId, invitationId],
      );
      await cancelOpenInvitationDeliveries(client, workspaceId, invitationId);
      const updated = await client.query<InvitationRow>(
        operation === 'resend'
          ? `update app.workspace_invitations
                set revision=$3,token_digest=$4,expires_at=$5,delivery_status='queued',updated_at=clock_timestamp()
              where workspace_id=$1 and id=$2 returning ${invitationSelection}`
          : `update app.workspace_invitations
                set revision=$3,status='revoked',revoked_at=clock_timestamp(),delivery_status='canceled',updated_at=clock_timestamp()
              where workspace_id=$1 and id=$2 returning ${invitationSelection}`,
        operation === 'resend'
          ? [
              workspaceId,
              invitationId,
              nextRevision,
              nextDelivery?.tokenDigest,
              nextDelivery?.expiresAt,
            ]
          : [workspaceId, invitationId, nextRevision],
      );
      const updatedInvitation = updated.rows[0];
      if (updatedInvitation === undefined)
        throw new Error('Invitation update returned no row');
      const invitation = mapInvitation(updatedInvitation);
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

async function listWorkspaceInvitations(
  pool: Pool,
  workspaceIdInput: Parameters<InvitationStore['listWorkspaceInvitations']>[0],
  actorIdInput: Parameters<InvitationStore['listWorkspaceInvitations']>[1],
  input: Parameters<InvitationStore['listWorkspaceInvitations']>[2] = {},
): ReturnType<InvitationStore['listWorkspaceInvitations']> {
  const workspaceId = parseIdentityUuid(workspaceIdInput);
  const actorUserId = parseIdentityUuid(actorIdInput);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(input.limit ?? 50);
  return withTenantScopedClient(
    pool,
    { workspaceId, actorId: actorUserId },
    async (client) => {
      await lockAuthorizedActor(client, workspaceId, actorUserId, 'share');
      await expireWorkspaceInvitations(client, { workspaceId });
      const values: unknown[] = [workspaceId, limit + 1];
      let after = '';
      if (input.after !== undefined) {
        values.push(
          input.after.createdAt,
          parseIdentityUuid(input.after.invitationId),
        );
        after = `and (created_at,id)<($3::timestamptz,$4::uuid)`;
      }
      const result = await client.query<InvitationRow>(
        `select ${invitationSelection},
                    to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at_cursor
               from app.workspace_invitations
              where workspace_id=$1 ${after}
              order by created_at desc,id desc limit $2`,
        values,
      );
      const visible = result.rows.slice(0, limit);
      const last = visible.at(-1);
      return Object.freeze({
        items: Object.freeze(visible.map(mapInvitation)),
        ...(result.rows.length > limit && last?.created_at_cursor !== undefined
          ? {
              nextCursor: Object.freeze({
                createdAt: last.created_at_cursor,
                invitationId: last.id,
              }),
            }
          : {}),
      });
    },
  );
}

async function createWorkspaceInvitation(
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
      const duplicate = await client.query(
        `select 1 from app.workspace_invitations
              where workspace_id=$1 and normalized_email=$2 and status='pending' for update`,
        [workspaceId, email],
      );
      if ((duplicate.rowCount ?? 0) > 0)
        throw new WorkspaceInvitationCommandConflictError(
          'duplicate_pending',
          'A pending invitation already exists for this recipient',
        );
      let inserted;
      try {
        inserted = await client.query<InvitationRow>(
          `insert into app.workspace_invitations
               (id,workspace_id,recipient_email,normalized_email,role,status,revision,
                token_digest,delivery_status,created_by,expires_at)
             values($1,$2,$3,$3,$4,'pending',1,$5,'queued',$6,$7)
             returning ${invitationSelection}`,
          [
            invitationId,
            workspaceId,
            email,
            role,
            tokenDigest,
            actorUserId,
            raw.expiresAt,
          ],
        );
      } catch (error: unknown) {
        if (readIdentityDatabaseErrorCode(error) === '23505')
          throw new WorkspaceInvitationCommandConflictError(
            'duplicate_pending',
            'A pending invitation already exists for this recipient',
            { cause: error },
          );
        throw error;
      }
      const insertedInvitation = inserted.rows[0];
      if (insertedInvitation === undefined)
        throw new Error('Invitation insert returned no row');
      const invitation = mapInvitation(insertedInvitation);
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
