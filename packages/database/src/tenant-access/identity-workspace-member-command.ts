import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';

import {
  claimCommand,
  completeCommand,
  type CommandIdentity,
} from '../platform/idempotency.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import { commandKeySchema } from './identity-command-primitives.js';
import type { MembershipRole } from './identity-workspace-contracts.js';
import { parseIdentityUuid } from './identity-workspace-support.js';
import { withTenantScopedClient } from './workspace.js';

/*
 * The shared half of the existing-member commands (ADR 037 role change,
 * ADR 042 removal and the ADR 047 membership lifecycle): the workspace-first
 * lock order, the locked participant rows, the actor-scoped command key and
 * the transaction that ties them together.
 */

/** The command's operation name in `idempotency_records`. */
type MemberCommandOperation =
  | 'workspace.member.role'
  | 'workspace.member.removal'
  | 'workspace.member.departure'
  | 'workspace.member.suspension'
  | 'workspace.ownership.transfer';

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
async function lockMemberCommandParticipants(
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

/** Appends the command's safe workspace audit fact. */
export async function recordMemberCommandAudit(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    actorUserId: string;
    targetUserId: string;
    action:
      | 'workspace.member_role_changed'
      | 'workspace.member_removed'
      | 'workspace.member_left'
      | 'workspace.member_suspended'
      | 'workspace.member_reactivated'
      | 'workspace.ownership_transferred';
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

/** The participants a command was admitted with, as locked. */
export type AdmittedMemberCommand = Readonly<{
  actor: LockedMember;
  target: LockedMember;
}>;

/** The validated workspace, actor and target identifiers of a command. */
export type MemberCommandScope = Readonly<{
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
}>;

type MemberCommandResult = Readonly<Record<string, unknown>>;

/**
 * Runs one existing-member command in a tenant transaction: lock the
 * participants, let the command admit its actor before its key is read,
 * replay an exact retry without rechecking the old state, and otherwise
 * apply the change and store its result in the same commit.
 */
export async function executeMemberCommand<Result extends MemberCommandResult>(
  pool: Pool,
  command: Readonly<{
    operation: MemberCommandOperation;
    workspaceId: string;
    actorUserId: string;
    targetUserId: string;
    idempotencyKey: string;
    /** The command body; identifiers are added to its request hash. */
    request: Readonly<Record<string, string | number>>;
    result: z.ZodType<Result>;
    conflict: (reason: 'actor_inactive', message: string) => Error;
    admit: (
      locked: Readonly<{
        actor: LockedMember | undefined;
        target: LockedMember | undefined;
      }>,
      scope: MemberCommandScope,
    ) => AdmittedMemberCommand;
    apply: (
      client: PoolClient,
      admitted: AdmittedMemberCommand,
      scope: MemberCommandScope,
    ) => Promise<Result>;
  }>,
): Promise<Result & Readonly<{ replayed: boolean }>> {
  const scope: MemberCommandScope = Object.freeze({
    workspaceId: parseIdentityUuid(command.workspaceId),
    actorUserId: parseIdentityUuid(command.actorUserId),
    targetUserId: parseIdentityUuid(command.targetUserId),
  });
  const key: CommandIdentity = {
    workspaceId: scope.workspaceId,
    operation: command.operation,
    scope: scope.actorUserId,
    idempotencyKey: commandKeySchema.parse(command.idempotencyKey),
  };
  return withTenantScopedClient(
    pool,
    { workspaceId: scope.workspaceId, actorId: scope.actorUserId },
    async (client) => {
      const locked = await lockMemberCommandParticipants(
        client,
        scope.workspaceId,
        scope.actorUserId,
        scope.targetUserId,
      );
      if (!locked.workspaceActive)
        throw command.conflict('actor_inactive', 'The workspace is not active');
      const admitted = command.admit(locked, scope);
      const stored = await claimCommand(client, {
        ...key,
        request: { ...command.request, targetUserId: scope.targetUserId },
        resourceId: scope.targetUserId,
      });
      if (stored !== null)
        return Object.freeze({
          ...command.result.parse(stored),
          replayed: true,
        });
      const result = command.result.parse(
        await command.apply(client, admitted, scope),
      );
      await completeCommand(client, key, result);
      return Object.freeze({ ...result, replayed: false });
    },
  );
}

/** Writes one membership's role, status and advanced role revision. */
export async function updateMembership(
  client: PoolClient,
  workspaceId: string,
  change: Readonly<{
    userId: string;
    role: MembershipRole;
    status: 'active' | 'suspended' | 'removed';
    roleRevision: number;
  }>,
): Promise<void> {
  await client.query(
    `update app.workspace_memberships
     set role=$3,status=$4,role_revision=$5,updated_at=clock_timestamp()
     where workspace_id=$1 and user_id=$2`,
    [
      workspaceId,
      change.userId,
      change.role,
      change.status,
      change.roleRevision,
    ],
  );
  // Favorites are private to a membership; a member who comes back starts
  // without them.
  if (change.status === 'removed')
    await client.query(
      'delete from app.workflow_favorites where workspace_id=$1 and actor_id=$2',
      [workspaceId, change.userId],
    );
}
