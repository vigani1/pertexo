import type { Pool } from 'pg';
import { z } from 'zod';

import type {
  IdentityWorkspaceDatabase,
  RemoveWorkspaceMemberInput,
} from './identity-workspace-contracts.js';
import { WorkspaceMemberRemovalCommandConflictError } from './identity-workspace-errors.js';
import {
  commandRevisionSchema,
  executeMemberCommand,
  isActiveMemberManager,
  recordMemberCommandAudit,
  updateMembership,
} from './identity-workspace-member-command.js';
import { revokeUserSessions } from './identity-workspace-session-store.js';
import { canRemoveWorkspaceMember } from './workspace-policy.js';

type RemovalStore = Pick<IdentityWorkspaceDatabase, 'removeWorkspaceMember'>;

const durableResult = z
  .object({ userId: z.uuid(), roleRevision: commandRevisionSchema })
  .strict();

function conflict(
  reason: ConstructorParameters<
    typeof WorkspaceMemberRemovalCommandConflictError
  >[0],
  message: string,
): WorkspaceMemberRemovalCommandConflictError {
  return new WorkspaceMemberRemovalCommandConflictError(reason, message);
}

/**
 * ADR 042 member removal. The membership becomes `removed` and its role
 * revision advances, the removed user's sessions end, and one safe audit
 * fact and the command receipt commit in the same transaction.
 */
export function createIdentityWorkspaceMemberRemovalStore(
  pool: Pool,
): RemovalStore {
  return Object.freeze({
    removeWorkspaceMember: (raw: RemoveWorkspaceMemberInput) => {
      const expectedRoleRevision = commandRevisionSchema.parse(
        raw.expectedRoleRevision,
      );
      return executeMemberCommand(pool, {
        table: 'workspace_member_removal_command_receipts',
        workspaceId: raw.workspaceId,
        actorUserId: raw.actorUserId,
        targetUserId: raw.targetUserId,
        idempotencyKey: raw.idempotencyKey,
        request: { expectedRoleRevision, operation: 'remove' },
        result: durableResult,
        conflict,
        admit: ({ actor, target }, scope) => {
          if (!isActiveMemberManager(actor))
            throw conflict(
              'actor_inactive',
              'The actor is no longer allowed to manage members',
            );
          if (scope.actorUserId === scope.targetUserId)
            throw conflict('self_removal', 'Members cannot remove themselves');
          if (target === undefined)
            throw conflict(
              'target_missing',
              'The workspace member was not found',
            );
          return { actor, target };
        },
        apply: async (client, { actor, target }, scope) => {
          if (target.status === 'removed')
            throw conflict(
              'target_inactive',
              'The member was already removed from this workspace',
            );
          if (target.role === 'owner')
            throw conflict(
              'owner_removal',
              'The workspace owner cannot be removed',
            );
          if (!canRemoveWorkspaceMember(actor.role, target.role))
            throw conflict(
              'removal_forbidden',
              'This member cannot be removed by the actor',
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
            status: 'removed',
            roleRevision: nextRevision,
          });
          await revokeUserSessions(client, target.user_id);
          await recordMemberCommandAudit(client, {
            ...scope,
            action: 'workspace.member_removed',
            requestId: raw.requestId,
            traceId: raw.traceId,
            metadata: {
              role: target.role,
              fromStatus: target.status,
              fromRevision: target.role_revision,
              toRevision: nextRevision,
            },
          });
          return { userId: target.user_id, roleRevision: nextRevision };
        },
      });
    },
  });
}
