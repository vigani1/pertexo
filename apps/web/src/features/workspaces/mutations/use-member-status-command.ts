import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import type { ApiClient } from '@/lib/api/client';
import { changeWorkspaceMemberStatus } from '../workspaces.api';
import {
  useMemberCommand,
  type MemberCommandAttempt,
} from './use-member-command';

export type MemberStatusDirection = 'suspend' | 'reactivate';
type StatusAttempt = MemberCommandAttempt &
  Readonly<{ direction: MemberStatusDirection }>;

const DONE: Readonly<Record<MemberStatusDirection, string>> = {
  suspend: 'suspended',
  reactivate: 'reactivated',
};

/**
 * Suspends or reactivates one member at the revision the confirmation
 * showed (ADR 047). An unconfirmed command repeats with its exact key.
 */
export function useMemberStatusCommand(
  input: Readonly<{
    apiClient: ApiClient;
    actorUserId: string;
    workspaceId: string;
    onChanged: (
      member: WorkspaceMember,
      direction: MemberStatusDirection,
    ) => void;
    onConflict: () => void;
    onAuthenticationLost: () => void;
    onPermissionLost: () => void;
    onTargetUnavailable: (member: WorkspaceMember) => void;
  }>,
) {
  const command = useMemberCommand<StatusAttempt>({
    ...input,
    send: (attempt) =>
      changeWorkspaceMemberStatus(
        input.apiClient,
        input.workspaceId,
        attempt.targetUserId,
        attempt,
      ),
    copy: {
      uncertain: (member) =>
        `We couldn’t confirm whether ${member.displayName}’s access changed. Try again — Pertexo recognizes the repeat, so it can’t happen twice.`,
      conflict: (member) =>
        `${member.displayName} changed while you were deciding. Check their row, then try again if you still want to.`,
      action: 'changing this member’s access',
    },
    onDone: (attempt) => {
      input.onChanged(attempt.member, attempt.direction);
    },
  });
  return {
    ...command,
    activeMember: command.activeAttempt?.member,
    activeDirection: command.activeAttempt?.direction,
    start: (member: WorkspaceMember, direction: MemberStatusDirection) =>
      command.start({
        member,
        targetUserId: member.userId,
        direction,
        expectedRoleRevision: member.roleRevision,
        idempotencyKey: crypto.randomUUID(),
      }),
  };
}

/** "suspended", "reactivated". */
export function statusChangeDone(direction: MemberStatusDirection): string {
  return DONE[direction];
}
