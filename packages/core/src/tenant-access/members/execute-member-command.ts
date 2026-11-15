import type { CommandIdentity } from '@pertexo/database/primitives';
import {
  claimCommand,
  completeCommand,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import type { Pool, PoolClient } from 'pg';
import type { ZodType } from 'zod';
import { DirectoryManagedMembershipError } from '../tenant-access.errors.js';
import { requireReadableReceipt } from '../../shared/receipts.js';
import {
  hasDirectoryMembership,
  lockMemberCommandParticipants,
  type LockedMember,
} from './commands.repository.js';

/** The command's operation name in `idempotency_records`. */
type MemberCommandOperation =
  | 'workspace.member.role'
  | 'workspace.member.removal'
  | 'workspace.member.departure'
  | 'workspace.member.suspension'
  | 'workspace.ownership.transfer';

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
 * Off withWorkspaceAccess: it locks both users for update, in id order. The
 * helper's share lock on the actor's user would come first, and two commands
 * touching that user in two workspaces would each hold it and wait for the other's
 * update, dying with 40P01. 'exclusive' only runs one at a time per workspace.
 *
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
    /** What its stored result must hold to be replayed. */
    receipt: ZodType;
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
      const stored = await claimCommand<Result>(client, {
        ...key,
        request: { ...command.request, targetUserId: scope.targetUserId },
        resourceId: scope.targetUserId,
      });
      if (stored !== null) {
        requireReadableReceipt(command.receipt, stored);
        return Object.freeze({
          ...stored,
          replayed: true,
        });
      }
      if (
        await hasDirectoryMembership(
          client,
          scope.workspaceId,
          scope.targetUserId,
        )
      )
        throw new DirectoryManagedMembershipError();
      const result = await command.apply(client, admitted, scope);
      await completeCommand(client, key, result);
      return Object.freeze({ ...result, replayed: false });
    },
  );
}
