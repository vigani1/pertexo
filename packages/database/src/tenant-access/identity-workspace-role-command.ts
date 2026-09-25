import type { Pool } from 'pg';
import { z } from 'zod';

import type {
  ChangeWorkspaceMemberRoleInput,
  IdentityWorkspaceDatabase,
  WorkspaceMemberRoleChangeResult,
} from './identity-workspace-contracts.js';
import { WorkspaceMemberRoleCommandConflictError } from './identity-workspace-errors.js';
import {
  claimMemberCommandReceipt,
  completeMemberCommandReceipt,
  isActiveMemberManager,
  lockMemberCommandParticipants,
  commandKeyHash,
  commandKeySchema,
  commandRequestHash,
  commandRevisionSchema,
  recordMemberCommandAudit,
} from './identity-workspace-member-command.js';
import { revokeUserSessions } from './identity-workspace-session-store.js';
import { parseIdentityUuid } from './identity-workspace-support.js';
import { canChangeWorkspaceMemberRole } from './workspace-policy.js';
import { withTenantScopedClient } from './workspace.js';

type RoleCommandStore = Pick<
  IdentityWorkspaceDatabase,
  'changeWorkspaceMemberRole'
>;

const RECEIPTS = 'workspace_member_role_command_receipts';
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
    changeWorkspaceMemberRole: async (raw: ChangeWorkspaceMemberRoleInput) => {
      const workspaceId = parseIdentityUuid(raw.workspaceId);
      const actorUserId = parseIdentityUuid(raw.actorUserId);
      const targetUserId = parseIdentityUuid(raw.targetUserId);
      const role = inputRole.parse(raw.role);
      const expectedRoleRevision = commandRevisionSchema.parse(
        raw.expectedRoleRevision,
      );
      const keyHash = commandKeyHash(
        commandKeySchema.parse(raw.idempotencyKey),
      );
      const commandHash = commandRequestHash({
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
          const { workspaceActive, actor, target } =
            await lockMemberCommandParticipants(
              client,
              workspaceId,
              actorUserId,
              targetUserId,
            );
          if (!workspaceActive)
            throw conflict('actor_inactive', 'The workspace is not active');
          if (!isActiveMemberManager(actor))
            throw conflict(
              'actor_inactive',
              'The actor is no longer allowed to manage members',
            );
          if (actorUserId === targetUserId)
            throw conflict(
              'self_change',
              'Members cannot change their own role',
            );
          if (target === undefined)
            throw conflict(
              'target_missing',
              'The workspace member was not found',
            );

          const receipt = await claimMemberCommandReceipt(client, RECEIPTS, {
            workspaceId,
            actorUserId,
            targetUserId,
            keyHash,
            requestHash: commandHash,
          });
          if (!('claimId' in receipt)) {
            if (receipt.requestHash !== commandHash)
              throw conflict(
                'idempotency_conflict',
                'The idempotency key belongs to another member role command',
              );
            const parsed = durableResult.safeParse(receipt.resultRef);
            if (receipt.status !== 'completed' || !parsed.success)
              throw new Error(
                'Workspace member role command receipt is incomplete',
              );
            return Object.freeze({ ...parsed.data, replayed: true });
          }

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
            await client.query(
              `update app.workspace_memberships
               set role=$3,role_revision=$4,updated_at=clock_timestamp()
               where workspace_id=$1 and user_id=$2`,
              [workspaceId, targetUserId, role, nextRevision],
            );
            await revokeUserSessions(client, targetUserId);
            await recordMemberCommandAudit(client, {
              workspaceId,
              actorUserId,
              targetUserId,
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
          const result = durableResult.parse({
            userId: targetUserId,
            role,
            roleRevision: nextRevision,
            changed,
          });
          await completeMemberCommandReceipt(
            client,
            RECEIPTS,
            receipt.claimId,
            result,
          );
          return Object.freeze({ ...result, replayed: false });
        },
      );
    },
  });
}
