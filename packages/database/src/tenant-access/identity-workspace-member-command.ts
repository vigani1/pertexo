import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { generatePersistedId } from '../platform/persisted-id.js';
import type { MembershipRole } from './identity-workspace-contracts.js';

/*
 * The shared half of the existing-member commands (ADR 037 role change and
 * ADR 042 removal): the workspace-first lock order, the locked participant
 * rows, and the actor/workspace-scoped command receipt.
 */

type MemberCommandReceiptTable =
  | 'workspace_member_role_command_receipts'
  | 'workspace_member_removal_command_receipts';

export const commandRevisionSchema = z.number().int().positive();
export const commandKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u);

export function commandKeyHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function commandRequestHash(
  input: Readonly<Record<string, unknown>>,
): string {
  return commandKeyHash(JSON.stringify(input, Object.keys(input).sort()));
}

export type LockedMember = Readonly<{
  user_id: string;
  role: MembershipRole;
  status: string;
  role_revision: number;
  user_status: string;
}>;

/**
 * Locks the workspace, then both users and memberships in identifier order,
 * matching the lock order of every other membership and lifecycle writer.
 */
export async function lockMemberCommandParticipants(
  client: PoolClient,
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
): Promise<
  Readonly<{
    workspaceActive: boolean;
    actor: LockedMember | undefined;
    target: LockedMember | undefined;
  }>
> {
  const workspace = await client.query<{ status: string }>(
    `select status from app.workspaces where id=$1 for update`,
    [workspaceId],
  );
  const userIds = [actorUserId, targetUserId].sort();
  await client.query(
    `select id from app.users where id=any($1::uuid[]) order by id for update`,
    [userIds],
  );
  const memberships = await client.query<LockedMember>(
    `select membership.user_id,membership.role,membership.status,
            membership.role_revision,user_record.status user_status
     from app.workspace_memberships membership
     join app.users user_record on user_record.id=membership.user_id
     where membership.workspace_id=$1 and membership.user_id=any($2::uuid[])
     order by membership.user_id for update of membership,user_record`,
    [workspaceId, userIds],
  );
  return Object.freeze({
    workspaceActive: workspace.rows[0]?.status === 'active',
    actor: memberships.rows.find((item) => item.user_id === actorUserId),
    target: memberships.rows.find((item) => item.user_id === targetUserId),
  });
}

/** An owner or admin whose membership and user are both active. */
export function isActiveMemberManager(
  actor: LockedMember | undefined,
): actor is LockedMember {
  return (
    actor?.status === 'active' &&
    actor.user_status === 'active' &&
    (actor.role === 'owner' || actor.role === 'admin')
  );
}

type ClaimedReceipt =
  | Readonly<{ claimId: string }>
  | Readonly<{ requestHash: string; status: string; resultRef: unknown }>;

/** Claims a new receipt, or locks and returns the existing one for the key. */
export async function claimMemberCommandReceipt(
  client: PoolClient,
  table: MemberCommandReceiptTable,
  input: Readonly<{
    workspaceId: string;
    actorUserId: string;
    targetUserId: string;
    keyHash: string;
    requestHash: string;
  }>,
): Promise<ClaimedReceipt> {
  const claimId = generatePersistedId();
  const inserted = await client.query(
    `insert into app.${table}
       (id,workspace_id,actor_user_id,target_user_id,key_hash,request_hash,status)
     values($1,$2,$3,$4,$5,$6,'in_progress')
     on conflict(actor_user_id,workspace_id,key_hash) do nothing`,
    [
      claimId,
      input.workspaceId,
      input.actorUserId,
      input.targetUserId,
      input.keyHash,
      input.requestHash,
    ],
  );
  if (inserted.rowCount === 1) return { claimId };
  const existing = await client.query<{
    request_hash: string;
    status: string;
    result_ref: unknown;
  }>(
    `select request_hash,status,result_ref
     from app.${table}
     where actor_user_id=$1 and workspace_id=$2 and key_hash=$3 for update`,
    [input.actorUserId, input.workspaceId, input.keyHash],
  );
  const row = existing.rows[0];
  return Object.freeze({
    requestHash: row?.request_hash ?? '',
    status: row?.status ?? '',
    resultRef: row?.result_ref,
  });
}

/** Records the applied result; a receipt completes exactly once. */
export async function completeMemberCommandReceipt(
  client: PoolClient,
  table: MemberCommandReceiptTable,
  claimId: string,
  result: unknown,
): Promise<void> {
  const completed = await client.query(
    `update app.${table}
     set status='completed',result_ref=$2::jsonb,updated_at=clock_timestamp()
     where id=$1 and status='in_progress'`,
    [claimId, JSON.stringify(result)],
  );
  if (completed.rowCount !== 1)
    throw new Error('Workspace member command receipt could not be completed');
}

/** Appends the command's safe workspace audit fact. */
export async function recordMemberCommandAudit(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    actorUserId: string;
    targetUserId: string;
    action: 'workspace.member_role_changed' | 'workspace.member_removed';
    requestId: string | undefined;
    traceId: string | undefined;
    metadata: Readonly<Record<string, string | number>>;
  }>,
): Promise<void> {
  await client.query(
    `insert into app.audit_events
       (id,workspace_id,actor_user_id,action,target_type,target_id,
        request_id,trace_id,metadata)
     values($1,$2,$3,$4,'workspace_member',$5,$6,$7,$8::jsonb)`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.actorUserId,
      input.action,
      input.targetUserId,
      input.requestId ?? null,
      input.traceId ?? null,
      JSON.stringify(input.metadata),
    ],
  );
}
