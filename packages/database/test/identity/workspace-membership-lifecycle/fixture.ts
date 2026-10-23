import type { DelegatedRole } from '@pertexo/workflow-model';
import { randomUUID } from 'node:crypto';

import { useIdentityCommandDatabase } from '../command.support.js';

export const database = useIdentityCommandDatabase('membership');

export function command(
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
  expectedRoleRevision = 1,
) {
  return {
    workspaceId,
    actorUserId,
    targetUserId,
    expectedRoleRevision,
    idempotencyKey: `member-${randomUUID()}`,
  };
}

export function transfer(
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
  revisions: Readonly<{ target?: number; owner?: number }> = {},
) {
  return {
    ...command(workspaceId, actorUserId, targetUserId, revisions.target),
    expectedOwnerRoleRevision: revisions.owner ?? 1,
  };
}

export async function membership(workspaceId: string, userId: string) {
  const rows = await database.asAdmin<{
    status: string;
    role: string;
    role_revision: number;
  }>(
    `select status,role,role_revision from app.workspace_memberships
      where workspace_id=$1 and user_id=$2`,
    [workspaceId, userId],
  );
  return rows[0];
}

export async function facts(workspaceId: string, action: string) {
  return database.asAdmin<{
    actor_user_id: string;
    target_id: string;
    metadata: Record<string, unknown>;
  }>(
    `select actor_user_id,target_id,metadata from app.audit_events
      where workspace_id=$1 and action=$2 order by occurred_at`,
    [workspaceId, action],
  );
}

export async function team(...roles: readonly DelegatedRole[]) {
  const owner = await database.user('Lifecycle owner');
  const workspaceId = await database.workspace(owner.id);
  const members = [];
  for (const role of roles) {
    const person = await database.user(`Lifecycle ${role}`);
    await database.member(workspaceId, person.id, role);
    members.push(person.id);
  }
  return { owner: owner.id, workspaceId, members };
}
