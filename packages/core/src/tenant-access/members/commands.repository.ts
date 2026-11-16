import type { AuditMetadata } from '@pertexo/database/primitives';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../governance/audit/facts.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import {
  users,
  workspaceMemberships,
  authDirectoryMemberships,
} from '@pertexo/database/schema';

import { lockWorkspaceRow } from '../../shared/access/authority.repository.js';

/*
 * The shared half of the existing-member commands (ADR 037 role change,
 * ADR 042 removal and the ADR 047 membership lifecycle): the workspace-first
 * lock order, the locked participant rows, the actor-scoped command key and
 * the transaction that ties them together.
 */

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
export function readLockedMembers(
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
  const db = drizzle(client);
  const workspaceStatus = await lockWorkspaceRow(client, workspaceId);
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
    workspaceActive: workspaceStatus === 'active',
    actor: memberships.find((item) => item.user_id === actorUserId),
    target: memberships.find((item) => item.user_id === targetUserId),
  });
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

/** Whether the directory, not the workspace, manages the target's membership. */
export async function hasDirectoryMembership(
  client: PoolClient,
  workspaceId: string,
  targetUserId: string,
): Promise<boolean> {
  const directoryMembership = await drizzle(client)
    .select({ one: sql`1` })
    .from(authDirectoryMemberships)
    .where(
      and(
        eq(authDirectoryMemberships.workspaceId, workspaceId),
        eq(authDirectoryMemberships.userId, targetUserId),
      ),
    )
    .catch(rethrowQueryFailure);
  return directoryMembership.length !== 0;
}
