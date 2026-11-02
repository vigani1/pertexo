import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import {
  admin,
  identities,
  invitation,
  join,
  type WorkspaceStatus,
} from '../world.js';

export const LOST_ROLES = ['builder', 'operator', 'viewer'] as const;
export const OUT_OF_SERVICE: readonly WorkspaceStatus[] = [
  'pending_deletion',
  'purging',
  'deleted',
];

/** What came back, so two people's answers can be compared whole. */
export const answer = (work: Promise<unknown>) =>
  work.then(
    () => 'answered',
    (error: unknown) => {
      const { constructor, message, reason } = error as Error & {
        reason?: string;
      };
      return { error: constructor.name, reason, message };
    },
  );

export const refusal = (reason: string) =>
  expect.objectContaining({ reason }) as unknown;

export async function membership(workspaceId: string, userId: string) {
  const found = await admin.query<{ role: string; status: string }>(
    'select role,status from app.workspace_memberships where workspace_id=$1 and user_id=$2',
    [workspaceId, userId],
  );
  return found.rows[0];
}

export async function auditCount(workspaceId: string, action: string) {
  const found = await admin.query<{ count: number }>(
    'select count(*)::int count from app.audit_events where workspace_id=$1 and action=$2',
    [workspaceId, action],
  );
  return found.rows[0]?.count;
}

export async function receiptCount(workspaceId: string, operation: string) {
  const found = await admin.query<{ count: number }>(
    'select count(*)::int count from app.idempotency_records where workspace_id=$1 and operation=$2',
    [workspaceId, operation],
  );
  return found.rows[0]?.count;
}

export const key = () => ({ idempotencyKey: randomUUID() });

/** Every command a member flow has, aimed at a viewer freshly added for it. */
export const COMMANDS = {
  rename: (workspaceId: string, actorUserId: string) =>
    identities.renameWorkspace({
      workspaceId,
      actorUserId,
      name: `Renamed ${randomUUID()}`,
      expectedRevision: 1,
      ...key(),
    }),
  'role change': async (workspaceId: string, actorUserId: string) =>
    identities.changeWorkspaceMemberRole({
      workspaceId,
      actorUserId,
      targetUserId: await join(workspaceId, 'viewer'),
      role: 'builder',
      expectedRoleRevision: 1,
      ...key(),
    }),
  removal: async (workspaceId: string, actorUserId: string) =>
    identities.removeWorkspaceMember({
      workspaceId,
      actorUserId,
      targetUserId: await join(workspaceId, 'viewer'),
      expectedRoleRevision: 1,
      ...key(),
    }),
  suspension: async (workspaceId: string, actorUserId: string) =>
    identities.suspendWorkspaceMember({
      workspaceId,
      actorUserId,
      targetUserId: await join(workspaceId, 'viewer'),
      expectedRoleRevision: 1,
      ...key(),
    }),
  reactivation: async (workspaceId: string, actorUserId: string) =>
    identities.reactivateWorkspaceMember({
      workspaceId,
      actorUserId,
      targetUserId: await join(workspaceId, 'viewer', 'suspended'),
      expectedRoleRevision: 1,
      ...key(),
    }),
  'invitation create': (workspaceId: string, actorUserId: string) =>
    identities.createWorkspaceInvitation(invitation(workspaceId, actorUserId)),
} as const;
export const COMMAND_NAMES = Object.keys(COMMANDS) as (keyof typeof COMMANDS)[];
