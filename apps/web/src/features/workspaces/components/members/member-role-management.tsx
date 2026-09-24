import type {
  AccessibleWorkspace,
  UserProfileResponse,
  WorkspaceMember,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useState } from 'react';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import {
  assignableRoles,
  canChangeRoleOf,
  withArticle,
  type ManagedRole,
} from '../../model/workspace-roles';
import { useMemberRoleCommand } from '../../mutations/use-member-role-command';
import { MemberList, type MemberRoleControl } from './member-list';
import { MemberRoleDialog } from './member-role-dialog';

type Proposal = Readonly<{ member: WorkspaceMember; role: ManagedRole }>;

/**
 * Members with an inline role picker. Picking a role only proposes it; the
 * confirmation sends it, and an in-flight or unconfirmed change keeps the
 * confirmation on its original member.
 */
export function MemberRoleManagement({
  apiClient,
  user,
  workspace,
  members,
  onAccessLost,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  members: readonly WorkspaceMember[];
  onAccessLost: (loss: 'authentication' | 'permission') => void;
}>) {
  const notifications = useNotifications();
  const [proposal, setProposal] = useState<Proposal>();
  const command = useMemberRoleCommand({
    apiClient,
    actorUserId: user.id,
    workspaceId: workspace.id,
    onChanged: (member, role) => {
      setProposal(undefined);
      notifications.success({
        title: `${member.displayName} is now ${withArticle(role)}`,
      });
    },
    onConflict: () => {
      setProposal(undefined);
    },
    onAuthenticationLost: () => {
      onAccessLost('authentication');
    },
    onPermissionLost: () => {
      onAccessLost('permission');
    },
    onTargetUnavailable: () => {
      setProposal(undefined);
    },
  });
  const change: Proposal | undefined =
    command.activeMember !== undefined && command.activeRole !== undefined
      ? { member: command.activeMember, role: command.activeRole }
      : proposal;
  const feedback = command.feedback;
  const canManage = workspace.capabilities.includes('member:manage');
  const actor = { role: workspace.role, userId: user.id };

  const control: MemberRoleControl = {
    roles: assignableRoles(workspace.role),
    canChange: (member) => canManage && canChangeRoleOf(actor, member),
    shownRole: (member) =>
      change?.member.userId === member.userId ? change.role : member.role,
    disabled: command.locked,
    feedback: (member) =>
      feedback?.targetUserId === member.userId &&
      change?.member.userId !== member.userId
        ? feedback.message
        : undefined,
    onPick: (member, role) => {
      if (!command.locked && role !== member.role)
        setProposal({ member, role });
    },
  };

  return (
    <>
      <MemberList members={members} actorUserId={user.id} control={control} />
      <MemberRoleDialog
        change={change}
        pending={command.pending}
        locked={command.locked}
        retryAvailable={command.retryAvailable}
        error={
          command.error ??
          (feedback !== undefined &&
          feedback.targetUserId === change?.member.userId
            ? feedback.message
            : undefined)
        }
        onClose={() => {
          setProposal(undefined);
        }}
        onConfirm={() => {
          if (proposal !== undefined)
            void command.start(proposal.member, proposal.role);
        }}
        onRetry={() => {
          void command.retry();
        }}
        onDismissUncertain={command.dismiss}
      />
    </>
  );
}
