import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { generatePersistedId } from '../platform/persisted-id.js';
import type {
  ChangeWorkspaceInvitationInput,
  CreateWorkspaceInvitationInput,
  IdentityWorkspaceDatabase,
  MembershipRole,
  WorkspaceInvitationCommandResult,
  WorkspaceInvitationRecord,
} from './identity-workspace-contracts.js';
import { WorkspaceInvitationCommandConflictError } from './identity-workspace-errors.js';
import {
  parseIdentityUuid,
  readIdentityDatabaseErrorCode,
} from './identity-workspace-support.js';
import { canInviteWorkspaceRole } from './workspace-policy.js';
import { withTenantScopedClient } from './workspace.js';

type InvitationStore = Pick<
  IdentityWorkspaceDatabase,
  | 'listWorkspaceInvitations'
  | 'createWorkspaceInvitation'
  | 'resendWorkspaceInvitation'
  | 'revokeWorkspaceInvitation'
>;

const delegatedRole = z.enum(['admin', 'builder', 'operator', 'viewer']);
const revision = z.number().int().positive();
const idempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u)
  .refine((value) => !value.includes(','));
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const sealedToken = z
  .object({
    ciphertext: z.string().min(1).max(16_384),
    nonce: z.string().min(1).max(128),
    tag: z.string().min(1).max(256),
    keyVersion: z.string().min(1).max(64),
  })
  .strict();
const durableInvitation = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    email: z.email().max(320),
    role: delegatedRole,
    status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
    revision,
    deliveryStatus: z.enum(['queued', 'submitted', 'failed', 'canceled']),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
const durableResult = z.object({ invitation: durableInvitation }).strict();

type InvitationRow = Readonly<{
  id: string;
  workspace_id: string;
  recipient_email: string;
  role: string;
  status: string;
  revision: number;
  delivery_status: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  created_at_cursor?: string;
}>;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function normalizeEmail(value: string): string {
  return z.email().max(320).parse(value.trim()).normalize('NFKC').toLowerCase();
}

function mapInvitation(row: InvitationRow): WorkspaceInvitationRecord {
  return Object.freeze({
    id: z.uuid().parse(row.id),
    workspaceId: z.uuid().parse(row.workspace_id),
    email: z.email().parse(row.recipient_email),
    role: delegatedRole.parse(row.role),
    status: z
      .enum(['pending', 'accepted', 'revoked', 'expired'])
      .parse(row.status),
    revision: revision.parse(row.revision),
    deliveryStatus: z
      .enum(['queued', 'submitted', 'failed', 'canceled'])
      .parse(row.delivery_status),
    expiresAt: z.coerce.date().parse(row.expires_at),
    createdAt: z.coerce.date().parse(row.created_at),
    updatedAt: z.coerce.date().parse(row.updated_at),
  });
}

function serializeInvitation(invitation: WorkspaceInvitationRecord) {
  return durableInvitation.parse({
    ...invitation,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
    updatedAt: invitation.updatedAt.toISOString(),
  });
}

async function lockAuthorizedActor(
  client: PoolClient,
  workspaceId: string,
  actorUserId: string,
): Promise<MembershipRole> {
  const workspace = await client.query<{ status: string }>(
    'select status from app.workspaces where id=$1 for update',
    [workspaceId],
  );
  if (workspace.rows[0]?.status !== 'active')
    throw new WorkspaceInvitationCommandConflictError(
      'actor_inactive',
      'The workspace is not active',
    );
  const actor = await client.query<{
    role: MembershipRole;
    membership_status: string;
    user_status: string;
  }>(
    `select membership.role,membership.status membership_status,users.status user_status
       from app.users users
       join app.workspace_memberships membership on membership.user_id=users.id
      where users.id=$1 and membership.workspace_id=$2
      for update of users,membership`,
    [actorUserId, workspaceId],
  );
  const row = actor.rows[0];
  if (
    row?.user_status !== 'active' ||
    row.membership_status !== 'active' ||
    (row.role !== 'owner' && row.role !== 'admin')
  )
    throw new WorkspaceInvitationCommandConflictError(
      'actor_inactive',
      'The actor is no longer allowed to manage invitations',
    );
  return row.role;
}

async function claimCommand(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    actorUserId: string;
    operation: 'create' | 'resend' | 'revoke';
    idempotencyKey: string;
    request: Record<string, unknown>;
  }>,
): Promise<Readonly<{ id: string }> | WorkspaceInvitationCommandResult> {
  const keyHash = sha256(idempotencyKey.parse(input.idempotencyKey));
  const requestHash = sha256(canonicalJson(input.request));
  const claimId = generatePersistedId();
  const inserted = await client.query(
    `insert into app.workspace_invitation_command_receipts
       (id,workspace_id,actor_user_id,operation,key_hash,request_hash,status)
     values($1,$2,$3,$4,$5,$6,'in_progress')
     on conflict(actor_user_id,workspace_id,operation,key_hash) do nothing`,
    [
      claimId,
      input.workspaceId,
      input.actorUserId,
      input.operation,
      keyHash,
      requestHash,
    ],
  );
  if (inserted.rowCount === 1) return { id: claimId };
  const existing = await client.query<{
    request_hash: string;
    status: string;
    result_ref: unknown;
  }>(
    `select request_hash,status,result_ref
       from app.workspace_invitation_command_receipts
      where actor_user_id=$1 and workspace_id=$2 and operation=$3 and key_hash=$4
      for update`,
    [input.actorUserId, input.workspaceId, input.operation, keyHash],
  );
  const row = existing.rows[0];
  if (row?.request_hash !== requestHash)
    throw new WorkspaceInvitationCommandConflictError(
      'idempotency_conflict',
      'The idempotency key belongs to another invitation command',
    );
  const parsed = durableResult.safeParse(row.result_ref);
  if (row.status !== 'completed' || !parsed.success)
    throw new Error('Workspace invitation command receipt is incomplete');
  return Object.freeze({
    invitation: mapDurableInvitation(parsed.data.invitation),
    replayed: true,
  });
}

function mapDurableInvitation(
  invitation: z.output<typeof durableInvitation>,
): WorkspaceInvitationRecord {
  return Object.freeze({
    ...invitation,
    expiresAt: new Date(invitation.expiresAt),
    createdAt: new Date(invitation.createdAt),
    updatedAt: new Date(invitation.updatedAt),
  });
}

async function completeCommand(
  client: PoolClient,
  claimId: string,
  invitation: WorkspaceInvitationRecord,
): Promise<WorkspaceInvitationCommandResult> {
  const completed = await client.query(
    `update app.workspace_invitation_command_receipts
        set status='completed',result_ref=$2::jsonb,updated_at=clock_timestamp()
      where id=$1 and status='in_progress'`,
    [claimId, JSON.stringify({ invitation: serializeInvitation(invitation) })],
  );
  if (completed.rowCount !== 1)
    throw new Error('Workspace invitation command receipt was not completed');
  return Object.freeze({ invitation, replayed: false });
}

async function insertDelivery(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    invitationId: string;
    revision: number;
    deliveryAttemptId: string;
    sealed: z.output<typeof sealedToken>;
  }>,
): Promise<void> {
  await client.query(
    `insert into app.workspace_invitation_delivery_attempts
       (id,workspace_id,invitation_id,invitation_revision,status,
        token_ciphertext,token_nonce,token_tag,token_key_version,workspace_name)
     select $1,$2,$3,$4,'queued',$5,$6,$7,$8,workspace.name
       from app.workspaces workspace where workspace.id=$2`,
    [
      input.deliveryAttemptId,
      input.workspaceId,
      input.invitationId,
      input.revision,
      input.sealed.ciphertext,
      input.sealed.nonce,
      input.sealed.tag,
      input.sealed.keyVersion,
    ],
  );
  const outboxEventId = generatePersistedId();
  const payload = {
    deliveryAttemptId: input.deliveryAttemptId,
    invitationId: input.invitationId,
    outboxEventId,
    schemaVersion: 1,
    workspaceId: input.workspaceId,
  };
  const payloadJson = canonicalJson(payload);
  await client.query(
    `insert into app.outbox_events
       (id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
        payload,payload_checksum)
     values($1,$2,'deliver-workspace-invitation',1,'workspace-invitation',$3,$4::jsonb,$5)`,
    [
      outboxEventId,
      input.workspaceId,
      input.invitationId,
      payloadJson,
      sha256(payloadJson),
    ],
  );
}

async function recordAudit(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    actorUserId: string;
    invitationId: string;
    action: string;
    revision: number;
    role: string;
    requestId?: string;
    traceId?: string;
  }>,
): Promise<void> {
  await client.query(
    `insert into app.audit_events
       (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
     values($1,$2,$3,$4,'workspace_invitation',$5,$6,$7,$8::jsonb)`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.actorUserId,
      input.action,
      input.invitationId,
      input.requestId ?? null,
      input.traceId ?? null,
      JSON.stringify({ revision: input.revision, role: input.role }),
    ],
  );
}

const invitationSelection = `id,workspace_id,recipient_email,role,status,revision,
  delivery_status,expires_at,created_at,updated_at`;

export function createIdentityWorkspaceInvitationStore(
  pool: Pool,
): InvitationStore {
  return Object.freeze({
    listWorkspaceInvitations: async (
      workspaceIdInput,
      actorIdInput,
      input = {},
    ) => {
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
          await lockAuthorizedActor(client, workspaceId, actorUserId);
          await expireInvitations(client, workspaceId);
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
            ...(result.rows.length > limit &&
            last?.created_at_cursor !== undefined
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
    },

    createWorkspaceInvitation: async (raw: CreateWorkspaceInvitationInput) => {
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
      if (
        !(raw.expiresAt instanceof Date) ||
        raw.expiresAt.getTime() <= Date.now()
      )
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
          await client.query(
            `update app.workspace_invitations
                set status='expired',delivery_status='canceled',updated_at=clock_timestamp()
              where workspace_id=$1 and normalized_email=$2 and status='pending' and expires_at<=clock_timestamp()`,
            [workspaceId, email],
          );
          await client.query(
            `update app.workspace_invitation_delivery_attempts attempt
                set status='canceled',token_ciphertext=null,token_nonce=null,token_tag=null,
                    token_key_version=null,updated_at=clock_timestamp()
              where workspace_id=$1 and status in ('queued','failed','unknown')
                and exists (
                  select 1 from app.workspace_invitations invitation
                   where invitation.workspace_id=$1 and invitation.id=attempt.invitation_id
                     and invitation.normalized_email=$2 and invitation.status='expired'
                )`,
            [workspaceId, email],
          );
          const claim = await claimCommand(client, {
            workspaceId,
            actorUserId,
            operation: 'create',
            idempotencyKey: raw.idempotencyKey,
            request: { email, role },
          });
          if ('replayed' in claim) return claim;
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
            ...(raw.requestId === undefined
              ? {}
              : { requestId: raw.requestId }),
            ...(raw.traceId === undefined ? {} : { traceId: raw.traceId }),
          });
          return completeCommand(client, claim.id, invitation);
        },
      );
    },

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
  return withTenantScopedClient(
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
        await expireInvitations(client, workspaceId, invitationId);
        throw new WorkspaceInvitationCommandConflictError(
          'invitation_inactive',
          'The invitation has expired',
        );
      }
      const claim = await claimCommand(client, {
        workspaceId,
        actorUserId,
        operation,
        idempotencyKey: raw.idempotencyKey,
        request: { expectedRevision, invitationId },
      });
      if ('replayed' in claim) return claim;
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
      await client.query(
        `update app.workspace_invitation_delivery_attempts
            set status=case when status in ('queued','failed') then 'canceled' else status end,
                token_ciphertext=null,token_nonce=null,token_tag=null,
                token_key_version=null,updated_at=clock_timestamp()
          where workspace_id=$1 and invitation_id=$2
            and status in ('queued','failed','unknown')`,
        [workspaceId, invitationId],
      );
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
      return completeCommand(client, claim.id, invitation);
    },
  );
}

async function expireInvitations(
  client: PoolClient,
  workspaceId: string,
  invitationId?: string,
): Promise<void> {
  const values =
    invitationId === undefined ? [workspaceId] : [workspaceId, invitationId];
  const idClause = invitationId === undefined ? '' : 'and id=$2';
  await client.query(
    `update app.workspace_invitations
        set status='expired',delivery_status='canceled',updated_at=clock_timestamp()
      where workspace_id=$1 ${idClause} and status='pending' and expires_at<=clock_timestamp()`,
    values,
  );
  const attemptIdClause =
    invitationId === undefined ? '' : 'and invitation_id=$2';
  await client.query(
    `update app.workspace_invitation_delivery_attempts
        set status=case when status in ('queued','failed') then 'canceled' else status end,
            token_ciphertext=null,token_nonce=null,token_tag=null,
            token_key_version=null,updated_at=clock_timestamp()
      where workspace_id=$1 ${attemptIdClause} and status in ('queued','failed','unknown')
        and exists (
          select 1 from app.workspace_invitations invitation
           where invitation.workspace_id=$1 and invitation.id=workspace_invitation_delivery_attempts.invitation_id
             and invitation.status='expired'
        )`,
    values,
  );
  await client.query(
    `update app.workspace_invitation_acceptance_intents
        set status='superseded',updated_at=clock_timestamp()
      where workspace_id=$1 ${attemptIdClause} and status in ('pending','verified','wrong_account')
        and exists (
          select 1 from app.workspace_invitations invitation
           where invitation.workspace_id=$1 and invitation.id=workspace_invitation_acceptance_intents.invitation_id
             and invitation.status='expired'
        )`,
    values,
  );
}
