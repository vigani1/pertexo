import type { AuditMetadata } from '../../governance/audit/events.repository.js';
import { appendAuditFact } from '../../governance/audit/events.repository.js';
import { isAdministrativeRole } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import {
  users,
  workspaceMemberships,
  workspaces,
} from '../../schema/foundation.js';
import { authDirectoryMemberships } from '../../schema/identity/federation/directory/sources.js';

import type { CommandIdentity } from '../../platform/idempotency/contract.js';
import {
  claimCommand,
  completeCommand,
} from '../../platform/idempotency/repository.js';

import { DirectoryManagedMembershipError } from '../errors.js';
import { withTenantScopedClient } from '../transactions.js';

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

const membership = alias(workspaceMemberships, 'membership');
const userRecord = alias(users, 'user_record');
const memberSelection = {
  user_id: membership.userId,
  role: membership.role,
  status: membership.status,
  role_revision: membership.roleRevision,
  user_status: userRecord.status,
};
export type LockedMember = Awaited<
  ReturnType<typeof readLockedMembers>
>[number];
function readLockedMembers(
  client: PoolClient,
  workspaceId: string,
  userIds: readonly string[],
) {
  return drizzle(client)
    .select(memberSelection)
    .from(membership)
    .innerJoin(userRecord, eq(userRecord.id, membership.userId))
    .where(
      and(
        eq(membership.workspaceId, workspaceId),
        sql`${membership.userId}=any(${sql.param(userIds)}::uuid[])`,
      ),
    )
    .orderBy(membership.userId)
    .for('update', { of: [membership, userRecord] })
    .catch(rethrowQueryFailure);
}

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
  const db = drizzle(client);
  const workspace = await db
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('update')
    .catch(rethrowQueryFailure);
  const userIds = [actorUserId, targetUserId].sort();
  await db
    .select({ id: users.id })
    .from(users)
    .where(sql`${users.id}=any(${sql.param(userIds)}::uuid[])`)
    .orderBy(users.id)
    .for('update')
    .catch(rethrowQueryFailure);
  const memberships = await readLockedMembers(client, workspaceId, userIds);
  return Object.freeze({
    workspaceActive: workspace[0]?.status === 'active',
    actor: memberships.find((item) => item.user_id === actorUserId),
    target: memberships.find((item) => item.user_id === targetUserId),
  });
}

/** An owner or admin whose membership and user are both active. */
export function isActiveMemberManager(
  actor: LockedMember | undefined,
): actor is LockedMember {
  return (
    actor?.status === 'active' &&
    actor.user_status === 'active' &&
    isAdministrativeRole(actor.role)
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
    metadata: AuditMetadata;
  }>,
): Promise<void> {
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorUserId,
    action: input.action,
    targetType: 'workspace_member',
    targetId: input.targetUserId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata: input.metadata,
  });
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
    workspaceId: command.workspaceId,
    actorUserId: command.actorUserId,
    targetUserId: command.targetUserId,
  });
  const key: CommandIdentity = {
    workspaceId: scope.workspaceId,
    operation: command.operation,
    scope: scope.actorUserId,
    idempotencyKey: command.idempotencyKey,
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
      const directoryMembership = await drizzle(client)
        .select({ one: sql`1` })
        .from(authDirectoryMemberships)
        .where(
          and(
            eq(authDirectoryMemberships.workspaceId, scope.workspaceId),
            eq(authDirectoryMemberships.userId, scope.targetUserId),
          ),
        )
        .catch(rethrowQueryFailure);
      if (directoryMembership.length !== 0)
        throw new DirectoryManagedMembershipError();
      const result = await command.apply(client, admitted, scope);
      await completeCommand(client, key, result);
      return Object.freeze({ ...result, replayed: false });
    },
  );
}
