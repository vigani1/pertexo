import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import type { ApiClient } from '@/lib/api/client';
import { transferWorkspaceOwnership } from '../workspaces.api';
import {
  useMemberCommand,
  type MemberCommandAttempt,
} from './use-member-command';

type TransferAttempt = MemberCommandAttempt &
  Readonly<{ expectedOwnerRoleRevision: number }>;

/**
 * Makes another member the owner (ADR 047). Both memberships are fenced by
 * the revisions people saw, and the server may first ask for a fresh
 * sign-in, which keeps the confirmation open with a way to sign in again.
 */
export function useOwnershipTransferCommand(
  input: Readonly<{
    apiClient: ApiClient;
    actorUserId: string;
    workspaceId: string;
    onTransferred: (member: WorkspaceMember) => void;
    onConflict: () => void;
    onAuthenticationLost: () => void;
    onPermissionLost: () => void;
    onTargetUnavailable: (member: WorkspaceMember) => void;
  }>,
) {
  const command = useMemberCommand<TransferAttempt>({
    ...input,
    send: (attempt) =>
      transferWorkspaceOwnership(
        input.apiClient,
        input.workspaceId,
        attempt.targetUserId,
        attempt,
      ),
    copy: {
      uncertain: (member) =>
        `We couldn’t confirm whether ${member.displayName} became the owner. Try again — Pertexo recognises the repeat, so it can’t happen twice.`,
      conflict: (member) =>
        `${member.displayName} or your own membership changed while you were deciding. Check the team, then try again.`,
      action: 'transferring ownership',
    },
    onDone: (attempt) => {
      input.onTransferred(attempt.member);
    },
  });
  return {
    ...command,
    activeMember: command.activeAttempt?.member,
    /** `you` is the actor's own row, whose revision fences the transfer. */
    start: (member: WorkspaceMember, you: WorkspaceMember) =>
      command.start({
        member,
        targetUserId: member.userId,
        expectedRoleRevision: member.roleRevision,
        expectedOwnerRoleRevision: you.roleRevision,
        idempotencyKey: crypto.randomUUID(),
      }),
  };
}
