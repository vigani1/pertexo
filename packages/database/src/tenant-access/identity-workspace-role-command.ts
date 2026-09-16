import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { generatePersistedId } from '../platform/persisted-id.js';
import type {
  ChangeWorkspaceMemberRoleInput,
  IdentityWorkspaceDatabase,
  MembershipRole,
  WorkspaceMemberRoleChangeResult,
} from './identity-workspace-contracts.js';
import { WorkspaceMemberRoleCommandConflictError } from './identity-workspace-errors.js';
import { parseIdentityUuid } from './identity-workspace-support.js';
import { canChangeWorkspaceMemberRole } from './workspace-policy.js';
import { withTenantScopedClient } from './workspace.js';

type RoleCommandStore = Pick<
  IdentityWorkspaceDatabase,
  'changeWorkspaceMemberRole'
>;

const inputRole = z.enum(['admin', 'builder', 'operator', 'viewer']);
const revision = z.number().int().positive();
const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u);
const durableResult = z
  .object({
    userId: z.uuid(),
    role: inputRole,
    roleRevision: revision,
    changed: z.boolean(),
  })
  .strict();

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requestHash(input: Readonly<Record<string, unknown>>): string {
  return hash(JSON.stringify(input, Object.keys(input).sort()));
}

async function currentOrClaimedReceipt(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    actorUserId: string;
    targetUserId: string;
    keyHash: string;
    requestHash: string;
  }>,
): Promise<Readonly<{ claimId: string }> | WorkspaceMemberRoleChangeResult> {
  const claimId = generatePersistedId();
  const inserted = await client.query(
    `insert into app.workspace_member_role_command_receipts
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
     from app.workspace_member_role_command_receipts
     where actor_user_id=$1 and workspace_id=$2 and key_hash=$3 for update`,
    [input.actorUserId, input.workspaceId, input.keyHash],
  );
  const row = existing.rows[0];
  if (row?.request_hash !== input.requestHash)
    throw new WorkspaceMemberRoleCommandConflictError(
      'idempotency_conflict',
      'The idempotency key belongs to another member role command',
    );
  const parsed = durableResult.safeParse(row.result_ref);
  if (row.status !== 'completed' || !parsed.success)
    throw new Error('Workspace member role command receipt is incomplete');
  return Object.freeze({ ...parsed.data, replayed: true });
}

export function createIdentityWorkspaceRoleCommandStore(
  pool: Pool,
): RoleCommandStore {
  return Object.freeze({
    changeWorkspaceMemberRole: async (raw: ChangeWorkspaceMemberRoleInput) => {
      const workspaceId = parseIdentityUuid(raw.workspaceId);
      const actorUserId = parseIdentityUuid(raw.actorUserId);
      const targetUserId = parseIdentityUuid(raw.targetUserId);
      const role = inputRole.parse(raw.role);
      const expectedRoleRevision = revision.parse(raw.expectedRoleRevision);
      const keyHash = hash(key.parse(raw.idempotencyKey));
      const commandHash = requestHash({
        actorUserId,
        expectedRoleRevision,
        role,
        targetUserId,
        workspaceId,
      });

      return withTenantScopedClient(
        pool,
        { workspaceId, actorId: actorUserId },
        async (client): Promise<WorkspaceMemberRoleChangeResult> => {
          const workspace = await client.query<{ status: string }>(
            `select status from app.workspaces where id=$1 for update`,
            [workspaceId],
          );
          if (workspace.rows[0]?.status !== 'active')
            throw new WorkspaceMemberRoleCommandConflictError(
              'actor_inactive',
              'The workspace is not active',
            );

          const userIds = [actorUserId, targetUserId].sort();
          await client.query(
            `select id from app.users where id=any($1::uuid[]) order by id for update`,
            [userIds],
          );
          const memberships = await client.query<{
            user_id: string;
            role: MembershipRole;
            status: string;
            role_revision: number;
            user_status: string;
          }>(
            `select membership.user_id,membership.role,membership.status,
                    membership.role_revision,user_record.status user_status
             from app.workspace_memberships membership
             join app.users user_record on user_record.id=membership.user_id
             where membership.workspace_id=$1 and membership.user_id=any($2::uuid[])
             order by membership.user_id for update of membership,user_record`,
            [workspaceId, userIds],
          );
          const actor = memberships.rows.find(
            (item) => item.user_id === actorUserId,
          );
          if (
            actor?.status !== 'active' ||
            actor.user_status !== 'active' ||
            (actor.role !== 'owner' && actor.role !== 'admin')
          )
            throw new WorkspaceMemberRoleCommandConflictError(
              'actor_inactive',
              'The actor is no longer allowed to manage members',
            );
          if (actorUserId === targetUserId)
            throw new WorkspaceMemberRoleCommandConflictError(
              'self_change',
              'Members cannot change their own role',
            );
          const target = memberships.rows.find(
            (item) => item.user_id === targetUserId,
          );
          if (target === undefined)
            throw new WorkspaceMemberRoleCommandConflictError(
              'target_missing',
              'The workspace member was not found',
            );

          const receipt = await currentOrClaimedReceipt(client, {
            workspaceId,
            actorUserId,
            targetUserId,
            keyHash,
            requestHash: commandHash,
          });
          if ('replayed' in receipt) return receipt;

          if (target.status !== 'active' || target.user_status !== 'active')
            throw new WorkspaceMemberRoleCommandConflictError(
              'target_inactive',
              'Only active members can change roles',
            );
          if (target.role === 'owner')
            throw new WorkspaceMemberRoleCommandConflictError(
              'owner_change',
              'Workspace ownership cannot be changed here',
            );
          if (!canChangeWorkspaceMemberRole(actor.role, target.role, role))
            throw new WorkspaceMemberRoleCommandConflictError(
              'transition_forbidden',
              'The requested role transition is not allowed',
            );
          if (target.role_revision !== expectedRoleRevision)
            throw new WorkspaceMemberRoleCommandConflictError(
              'revision_conflict',
              'The member role changed since it was loaded',
            );

          const changed = target.role !== role;
          const nextRevision = changed
            ? target.role_revision + 1
            : target.role_revision;
          if (changed) {
            await client.query(
              `update app.workspace_memberships
               set role=$3,role_revision=$4,updated_at=clock_timestamp()
               where workspace_id=$1 and user_id=$2`,
              [workspaceId, targetUserId, role, nextRevision],
            );
            await client.query(
              `update app.sessions set revoked_at=coalesce(revoked_at,clock_timestamp())
               where user_id=$1 and revoked_at is null`,
              [targetUserId],
            );
            await client.query(
              `insert into app.audit_events
                 (id,workspace_id,actor_user_id,action,target_type,target_id,
                  request_id,trace_id,metadata)
               values($1,$2,$3,'workspace.member_role_changed','workspace_member',$4,$5,$6,$7::jsonb)`,
              [
                generatePersistedId(),
                workspaceId,
                actorUserId,
                targetUserId,
                raw.requestId ?? null,
                raw.traceId ?? null,
                JSON.stringify({
                  fromRole: target.role,
                  toRole: role,
                  fromRevision: target.role_revision,
                  toRevision: nextRevision,
                }),
              ],
            );
          }
          const result = durableResult.parse({
            userId: targetUserId,
            role,
            roleRevision: nextRevision,
            changed,
          });
          const completed = await client.query(
            `update app.workspace_member_role_command_receipts
             set status='completed',result_ref=$2::jsonb,updated_at=clock_timestamp()
             where id=$1 and status='in_progress'`,
            [receipt.claimId, JSON.stringify(result)],
          );
          if (completed.rowCount !== 1)
            throw new Error(
              'Workspace member role command receipt could not be completed',
            );
          return Object.freeze({ ...result, replayed: false });
        },
      );
    },
  });
}
