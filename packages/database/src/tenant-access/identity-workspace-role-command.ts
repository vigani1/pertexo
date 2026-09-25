import type { Pool } from 'pg';
import { z } from 'zod';

import type {
  ChangeWorkspaceMemberRoleInput,
  IdentityWorkspaceDatabase,
  WorkspaceMemberRoleChangeResult,
} from './identity-workspace-contracts.js';
import { WorkspaceMemberRoleCommandConflictError } from './identity-workspace-errors.js';
import {
  commandRevisionSchema,
  executeMemberCommand,
  isActiveMemberManager,
  recordMemberCommandAudit,
  updateMembership,
} from './identity-workspace-member-command.js';
import { revokeUserSessions } from './identity-workspace-session-store.js';
import { canChangeWorkspaceMemberRole } from './workspace-policy.js';

type RoleCommandStore = Pick<
  IdentityWorkspaceDatabase,
  'changeWorkspaceMemberRole'
>;

const inputRole = z.enum(['admin', 'builder', 'operator', 'viewer']);
const durableResult = z
  .object({
    userId: z.uuid(),
    role: inputRole,
    roleRevision: commandRevisionSchema,
    changed: z.boolean(),
  })
  .strict();

function conflict(
  reason: ConstructorParameters<
    typeof WorkspaceMemberRoleCommandConflictError
  >[0],
  message: string,
): WorkspaceMemberRoleCommandConflictError {
  return new WorkspaceMemberRoleCommandConflictError(reason, message);
}

export function createIdentityWorkspaceRoleCommandStore(
  pool: Pool,
): RoleCommandStore {
  return Object.freeze({
    changeWorkspaceMemberRole: (raw: ChangeWorkspaceMemberRoleInput) => {
      const role = inputRole.parse(raw.role);
      const expectedRoleRevision = commandRevisionSchema.parse(
        raw.expectedRoleRevision,
      );
      return executeMemberCommand(pool, {
        table: 'workspace_member_role_command_receipts',
        workspaceId: raw.workspaceId,
        actorUserId: raw.actorUserId,
        targetUserId: raw.targetUserId,
        idempotencyKey: raw.idempotencyKey,
        request: { expectedRoleRevision, role },
        result: durableResult,
        conflict,
        admit: ({ actor, target }, scope) => {
          if (!isActiveMemberManager(actor))
            throw conflict(
              'actor_inactive',
              'The actor is no longer allowed to manage members',
            );
          if (scope.actorUserId === scope.targetUserId)
            throw conflict(
              'self_change',
              'Members cannot change their own role',
            );
          if (target === undefined)
            throw conflict(
              'target_missing',
              'The workspace member was not found',
            );
          return { actor, target };
        },
        apply: async (
          client,
          { actor, target },
          scope,
        ): Promise<Omit<WorkspaceMemberRoleChangeResult, 'replayed'>> => {
          if (target.status !== 'active' || target.user_status !== 'active')
            throw conflict(
              'target_inactive',
              'Only active members can change roles',
            );
          if (target.role === 'owner')
            throw conflict(
              'owner_change',
              'Workspace ownership cannot be changed here',
            );
          if (!canChangeWorkspaceMemberRole(actor.role, target.role, role))
            throw conflict(
              'transition_forbidden',
              'The requested role transition is not allowed',
            );
          if (target.role_revision !== expectedRoleRevision)
            throw conflict(
              'revision_conflict',
              'The member role changed since it was loaded',
            );

          const changed = target.role !== role;
          const nextRevision = changed
            ? target.role_revision + 1
            : target.role_revision;
          if (changed) {
            await updateMembership(client, scope.workspaceId, {
              userId: target.user_id,
              role,
              status: 'active',
              roleRevision: nextRevision,
            });
            await revokeUserSessions(client, target.user_id);
            await recordMemberCommandAudit(client, {
              ...scope,
              action: 'workspace.member_role_changed',
              requestId: raw.requestId,
              traceId: raw.traceId,
              metadata: {
                fromRole: target.role,
                toRole: role,
                fromRevision: target.role_revision,
                toRevision: nextRevision,
              },
            });
          }
          return {
            userId: target.user_id,
            role,
            roleRevision: nextRevision,
            changed,
          };
        },
      });
    },
  });
}
