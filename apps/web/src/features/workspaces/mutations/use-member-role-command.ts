import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import type { ApiClient } from '@/lib/api/client';
import type { ManagedRole } from '../model/workspace-roles';
import { changeWorkspaceMemberRole } from '../workspaces.api';
import {
  useMemberCommand,
  type MemberCommandAttempt,
} from './use-member-command';

type RoleAttempt = MemberCommandAttempt & Readonly<{ role: ManagedRole }>;

/** Changes one member's role at the revision the confirmation showed. */
export function useMemberRoleCommand(
  input: Readonly<{
    apiClient: ApiClient;
    actorUserId: string;
    workspaceId: string;
    onChanged: (member: WorkspaceMember, role: ManagedRole) => void;
    onConflict: () => void;
    onAuthenticationLost: () => void;
    onPermissionLost: () => void;
    onTargetUnavailable: () => void;
  }>,
) {
  const command = useMemberCommand<RoleAttempt>({
    ...input,
    send: (attempt) =>
      changeWorkspaceMemberRole(
        input.apiClient,
        input.workspaceId,
        attempt.targetUserId,
        attempt,
      ),
    copy: {
      uncertain: (member) =>
        `We couldn’t confirm whether ${member.displayName}’s role changed. Try again — Pertexo recognizes the repeat, so it can’t change twice.`,
      conflict: (member) =>
        `${member.displayName}’s role changed while you were deciding. Choose again if you still want to change it.`,
      action: 'changing this role',
    },
    onDone: (attempt) => {
      input.onChanged(attempt.member, attempt.role);
    },
  });
  return {
    ...command,
    activeMember: command.activeAttempt?.member,
    activeRole: command.activeAttempt?.role,
    start: (member: WorkspaceMember, role: ManagedRole) =>
      command.start({
        member,
        targetUserId: member.userId,
        role,
        expectedRoleRevision: member.roleRevision,
        idempotencyKey: crypto.randomUUID(),
      }),
  };
}
