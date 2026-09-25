import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import type { ApiClient } from '@/lib/api/client';
import { removeWorkspaceMember } from '../workspaces.api';
import {
  useMemberCommand,
  type MemberCommandAttempt,
} from './use-member-command';

/**
 * Removes one member at the revision the confirmation showed. An unconfirmed
 * removal keeps its exact command, so a retry can never remove twice.
 */
export function useMemberRemovalCommand(
  input: Readonly<{
    apiClient: ApiClient;
    actorUserId: string;
    workspaceId: string;
    onRemoved: (member: WorkspaceMember) => void;
    onConflict: () => void;
    onAuthenticationLost: () => void;
    onPermissionLost: () => void;
    onTargetUnavailable: (member: WorkspaceMember) => void;
  }>,
) {
  const command = useMemberCommand<MemberCommandAttempt>({
    ...input,
    send: (attempt) =>
      removeWorkspaceMember(
        input.apiClient,
        input.workspaceId,
        attempt.targetUserId,
        attempt,
      ),
    copy: {
      uncertain: (member) =>
        `We couldn’t confirm whether ${member.displayName} was removed. Try again — Pertexo recognises the repeat, so it can’t happen twice.`,
      conflict: (member) =>
        `${member.displayName}’s role changed while you were deciding. Check it, then remove them again if you still want to.`,
      action: 'removing this member',
    },
    onDone: (attempt) => {
      input.onRemoved(attempt.member);
    },
  });
  return {
    ...command,
    activeMember: command.activeAttempt?.member,
    start: (member: WorkspaceMember) =>
      command.start({
        member,
        targetUserId: member.userId,
        expectedRoleRevision: member.roleRevision,
        idempotencyKey: crypto.randomUUID(),
      }),
  };
}
