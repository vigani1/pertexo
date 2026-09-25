import type { Pool } from 'pg';
import { z } from 'zod';

import type {
  IdentityWorkspaceDatabase,
  LeaveWorkspaceInput,
  TransferWorkspaceOwnershipInput,
  WorkspaceMemberStatusCommandInput,
} from './identity-workspace-contracts.js';
import {
  WorkspaceMembershipCommandConflictError,
  type WorkspaceMembershipCommandConflictReason,
} from './identity-workspace-errors.js';
import {
  commandRevisionSchema,
  executeMemberCommand,
  isActiveMemberManager,
  recordMemberCommandAudit,
  updateMembership,
  type AdmittedMemberCommand,
  type LockedMember,
} from './identity-workspace-member-command.js';
import { revokeUserSessions } from './identity-workspace-session-store.js';
import {
  canLeaveWorkspace,
  canSuspendWorkspaceMember,
  canTransferWorkspaceOwnership,
} from './workspace-policy.js';

type MembershipLifecycleStore = Pick<
  IdentityWorkspaceDatabase,
  | 'leaveWorkspace'
  | 'suspendWorkspaceMember'
  | 'reactivateWorkspaceMember'
  | 'transferWorkspaceOwnership'
>;

const departureResult = z
  .object({ userId: z.uuid(), roleRevision: commandRevisionSchema })
  .strict();
const statusResult = z
  .object({
    userId: z.uuid(),
    roleRevision: commandRevisionSchema,
    membershipStatus: z.enum(['active', 'suspended']),
  })
  .strict();
const transferResult = z
  .object({
    ownerUserId: z.uuid(),
    ownerRoleRevision: commandRevisionSchema,
    previousOwnerUserId: z.uuid(),
    previousOwnerRoleRevision: commandRevisionSchema,
  })
  .strict();

/** Suspension and reactivation are one command in two directions. */
const STATUS_CHANGES = Object.freeze({
  suspend: {
    from: 'active',
    to: 'suspended',
    action: 'workspace.member_suspended',
  },
  reactivate: {
    from: 'suspended',
    to: 'active',
    action: 'workspace.member_reactivated',
  },
} as const);

function conflict(
  reason: WorkspaceMembershipCommandConflictReason,
  message: string,
): WorkspaceMembershipCommandConflictError {
  return new WorkspaceMembershipCommandConflictError(reason, message);
}

/** A manager acting on another member who is still in the workspace. */
function admitManagedTarget(
  locked: Readonly<{
    actor: LockedMember | undefined;
    target: LockedMember | undefined;
  }>,
  scope: Readonly<{ actorUserId: string; targetUserId: string }>,
): AdmittedMemberCommand {
  const { actor, target } = locked;
  if (!isActiveMemberManager(actor))
    throw conflict(
      'actor_inactive',
      'The actor is no longer allowed to manage members',
    );
  if (scope.actorUserId === scope.targetUserId)
    throw conflict('self_command', 'Members cannot do this to themselves');
  if (target === undefined)
    throw conflict('target_missing', 'The workspace member was not found');
  return { actor, target };
}

function requireTargetPresent(target: LockedMember): void {
  if (target.status === 'removed')
    throw conflict(
      'target_removed',
      'The member is no longer in this workspace',
    );
}

/**
 * ADR 047 leave: any active member except the owner ends their own
 * membership. It is recorded like a removal, and every session of the person
 * ends, including the one that asked.
 */
function leaveWorkspace(pool: Pool, raw: LeaveWorkspaceInput) {
  return executeMemberCommand(pool, {
    table: 'workspace_member_departure_command_receipts',
    workspaceId: raw.workspaceId,
    actorUserId: raw.actorUserId,
    targetUserId: raw.actorUserId,
    idempotencyKey: raw.idempotencyKey,
    request: { operation: 'leave' },
    result: departureResult,
    conflict,
    // A completed departure still replays: the removed row stays.
    admit: ({ actor }) => {
      if (actor === undefined)
        throw conflict('actor_inactive', 'The actor is not a member');
      return { actor, target: actor };
    },
    apply: async (client, { actor }, scope) => {
      if (actor.status !== 'active' || actor.user_status !== 'active')
        throw conflict('actor_inactive', 'Only active members can leave');
      if (!canLeaveWorkspace(actor.role))
        throw conflict(
          'owner_departure',
          'The owner must transfer ownership before leaving',
        );
      const nextRevision = actor.role_revision + 1;
      await updateMembership(client, scope.workspaceId, {
        userId: actor.user_id,
        role: actor.role,
        status: 'removed',
        roleRevision: nextRevision,
      });
      await revokeUserSessions(client, actor.user_id);
      await recordMemberCommandAudit(client, {
        ...scope,
        action: 'workspace.member_left',
        requestId: raw.requestId,
        traceId: raw.traceId,
        metadata: {
          role: actor.role,
          fromRevision: actor.role_revision,
          toRevision: nextRevision,
        },
      });
      return { userId: actor.user_id, roleRevision: nextRevision };
    },
  });
}

/**
 * ADR 047 suspension and reactivation under the removal matrix. The role is
 * kept, the revision advances and the member's sessions end either way.
 */
function changeMemberStatus(
  pool: Pool,
  raw: WorkspaceMemberStatusCommandInput,
  direction: keyof typeof STATUS_CHANGES,
) {
  const change = STATUS_CHANGES[direction];
  const expectedRoleRevision = commandRevisionSchema.parse(
    raw.expectedRoleRevision,
  );
  return executeMemberCommand(pool, {
    table: 'workspace_member_suspension_command_receipts',
    workspaceId: raw.workspaceId,
    actorUserId: raw.actorUserId,
    targetUserId: raw.targetUserId,
    idempotencyKey: raw.idempotencyKey,
    request: { expectedRoleRevision, operation: direction },
    result: statusResult,
    conflict,
    admit: admitManagedTarget,
    apply: async (client, { actor, target }, scope) => {
      requireTargetPresent(target);
      if (target.role === 'owner')
        throw conflict('owner_target', 'The workspace owner cannot change');
      if (!canSuspendWorkspaceMember(actor.role, target.role))
        throw conflict(
          'command_forbidden',
          'This member cannot be changed by the actor',
        );
      if (target.status !== change.from || target.user_status !== 'active')
        throw conflict(
          'target_inactive',
          `Only ${change.from} members can be changed this way`,
        );
      if (target.role_revision !== expectedRoleRevision)
        throw conflict(
          'revision_conflict',
          'The member changed since it was loaded',
        );
      const nextRevision = target.role_revision + 1;
      await updateMembership(client, scope.workspaceId, {
        userId: target.user_id,
        role: target.role,
        status: change.to,
        roleRevision: nextRevision,
      });
      await revokeUserSessions(client, target.user_id);
      await recordMemberCommandAudit(client, {
        ...scope,
        action: change.action,
        requestId: raw.requestId,
        traceId: raw.traceId,
        metadata: {
          role: target.role,
          fromRevision: target.role_revision,
          toRevision: nextRevision,
        },
      });
      return {
        userId: target.user_id,
        roleRevision: nextRevision,
        membershipStatus: change.to,
      };
    },
  });
}

/**
 * ADR 047 ownership transfer. The owner becomes admin before the target
 * becomes owner, so the single-owner index holds at every statement; both
 * people's sessions end in the same commit.
 */
function transferWorkspaceOwnership(
  pool: Pool,
  raw: TransferWorkspaceOwnershipInput,
) {
  const expectedRoleRevision = commandRevisionSchema.parse(
    raw.expectedRoleRevision,
  );
  const expectedOwnerRoleRevision = commandRevisionSchema.parse(
    raw.expectedOwnerRoleRevision,
  );
  return executeMemberCommand(pool, {
    table: 'workspace_ownership_transfer_command_receipts',
    workspaceId: raw.workspaceId,
    actorUserId: raw.actorUserId,
    targetUserId: raw.targetUserId,
    idempotencyKey: raw.idempotencyKey,
    request: {
      expectedOwnerRoleRevision,
      expectedRoleRevision,
      operation: 'transfer_ownership',
    },
    result: transferResult,
    conflict,
    // The previous owner is an admin afterwards, so a completed transfer
    // still replays for them.
    admit: admitManagedTarget,
    apply: async (client, { actor, target }, scope) => {
      requireTargetPresent(target);
      if (!canTransferWorkspaceOwnership(actor.role, target.role))
        throw conflict(
          'command_forbidden',
          'Only the owner can transfer ownership',
        );
      if (target.status !== 'active' || target.user_status !== 'active')
        throw conflict(
          'target_inactive',
          'Only an active member can become the owner',
        );
      if (
        target.role_revision !== expectedRoleRevision ||
        actor.role_revision !== expectedOwnerRoleRevision
      )
        throw conflict(
          'revision_conflict',
          'A membership changed since it was loaded',
        );
      const ownerRevision = actor.role_revision + 1;
      const targetRevision = target.role_revision + 1;
      await updateMembership(client, scope.workspaceId, {
        userId: actor.user_id,
        role: 'admin',
        status: 'active',
        roleRevision: ownerRevision,
      });
      await updateMembership(client, scope.workspaceId, {
        userId: target.user_id,
        role: 'owner',
        status: 'active',
        roleRevision: targetRevision,
      });
      await revokeUserSessions(client, actor.user_id);
      await revokeUserSessions(client, target.user_id);
      await recordMemberCommandAudit(client, {
        ...scope,
        action: 'workspace.ownership_transferred',
        requestId: raw.requestId,
        traceId: raw.traceId,
        metadata: {
          fromRole: target.role,
          previousOwnerFromRevision: actor.role_revision,
          previousOwnerToRevision: ownerRevision,
          fromRevision: target.role_revision,
          toRevision: targetRevision,
        },
      });
      return {
        ownerUserId: target.user_id,
        ownerRoleRevision: targetRevision,
        previousOwnerUserId: actor.user_id,
        previousOwnerRoleRevision: ownerRevision,
      };
    },
  });
}

/** ADR 047 leave, suspend, reactivate and ownership transfer commands. */
export function createIdentityWorkspaceMembershipLifecycleStore(
  pool: Pool,
): MembershipLifecycleStore {
  return Object.freeze({
    leaveWorkspace: (input) => leaveWorkspace(pool, input),
    suspendWorkspaceMember: (input) =>
      changeMemberStatus(pool, input, 'suspend'),
    reactivateWorkspaceMember: (input) =>
      changeMemberStatus(pool, input, 'reactivate'),
    transferWorkspaceOwnership: (input) =>
      transferWorkspaceOwnership(pool, input),
  });
}
