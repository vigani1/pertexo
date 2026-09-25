import type { Pool } from 'pg';
import { z } from 'zod';

import type {
  IdentityWorkspaceDatabase,
  RemoveWorkspaceMemberInput,
  WorkspaceMemberRemovalResult,
} from './identity-workspace-contracts.js';
import { WorkspaceMemberRemovalCommandConflictError } from './identity-workspace-errors.js';
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
import { canRemoveWorkspaceMember } from './workspace-policy.js';
import { withTenantScopedClient } from './workspace.js';

type RemovalStore = Pick<IdentityWorkspaceDatabase, 'removeWorkspaceMember'>;

const RECEIPTS = 'workspace_member_removal_command_receipts';
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
    removeWorkspaceMember: async (raw: RemoveWorkspaceMemberInput) => {
      const workspaceId = parseIdentityUuid(raw.workspaceId);
      const actorUserId = parseIdentityUuid(raw.actorUserId);
      const targetUserId = parseIdentityUuid(raw.targetUserId);
      const expectedRoleRevision = commandRevisionSchema.parse(
        raw.expectedRoleRevision,
      );
      const keyHash = commandKeyHash(
        commandKeySchema.parse(raw.idempotencyKey),
      );
      const commandHash = commandRequestHash({
        actorUserId,
        expectedRoleRevision,
        operation: 'remove',
        targetUserId,
        workspaceId,
      });

      return withTenantScopedClient(
        pool,
        { workspaceId, actorId: actorUserId },
        async (client): Promise<WorkspaceMemberRemovalResult> => {
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
            throw conflict('self_removal', 'Members cannot remove themselves');
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
                'The idempotency key belongs to another member removal',
              );
            const parsed = durableResult.safeParse(receipt.resultRef);
            if (receipt.status !== 'completed' || !parsed.success)
              throw new Error('Workspace member removal receipt is incomplete');
            return Object.freeze({ ...parsed.data, replayed: true });
          }

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
          await client.query(
            `update app.workspace_memberships
             set status='removed',role_revision=$3,updated_at=clock_timestamp()
             where workspace_id=$1 and user_id=$2`,
            [workspaceId, targetUserId, nextRevision],
          );
          await revokeUserSessions(client, targetUserId);
          await recordMemberCommandAudit(client, {
            workspaceId,
            actorUserId,
            targetUserId,
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
          const result = durableResult.parse({
            userId: targetUserId,
            roleRevision: nextRevision,
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
