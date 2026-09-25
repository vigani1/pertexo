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
  canRemoveMember,
  withArticle,
  type ManagedRole,
} from '../../model/workspace-roles';
import { useMemberRemovalCommand } from '../../mutations/use-member-removal-command';
import { useMemberRoleCommand } from '../../mutations/use-member-role-command';
import { MemberList, type MemberRowControl } from './member-list';
import { MemberRemovalDialog } from './member-removal-dialog';
import { MemberRoleDialog } from './member-role-dialog';

type Proposal = Readonly<{ member: WorkspaceMember; role: ManagedRole }>;
type AccessLoss = 'authentication' | 'permission';

/** Row feedback belongs to the member it is about, while no dialog shows it. */
function rowFeedback(
  feedback: Readonly<{ targetUserId: string; message: string }> | undefined,
  member: WorkspaceMember,
  shownInDialog: WorkspaceMember | undefined,
): string | undefined {
  return feedback?.targetUserId === member.userId &&
    shownInDialog?.userId !== member.userId
    ? feedback.message
    : undefined;
}

/**
 * Members with an inline role picker and a Remove action. Picking a role or
 * Remove only proposes it; the confirmation sends it, and an in-flight or
 * unconfirmed command keeps its confirmation on its original member.
 */
export function MemberManagement({
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
  onAccessLost: (loss: AccessLoss) => void;
}>) {
  const notifications = useNotifications();
  const [proposal, setProposal] = useState<Proposal>();
  const [removalTarget, setRemovalTarget] = useState<WorkspaceMember>();
  const scope = {
    apiClient,
    actorUserId: user.id,
    workspaceId: workspace.id,
    onAuthenticationLost: () => {
      onAccessLost('authentication');
    },
    onPermissionLost: () => {
      onAccessLost('permission');
    },
  };
  const roleCommand = useMemberRoleCommand({
    ...scope,
    onChanged: (member, role) => {
      setProposal(undefined);
      notifications.success({
        title: `${member.displayName} is now ${withArticle(role)}`,
      });
    },
    onConflict: () => {
      setProposal(undefined);
    },
    onTargetUnavailable: () => {
      setProposal(undefined);
    },
  });
  const removal = useMemberRemovalCommand({
    ...scope,
    onRemoved: (member) => {
      setRemovalTarget(undefined);
      notifications.success({
        title: `${member.displayName} was removed from ${workspace.name}`,
      });
    },
    onConflict: () => {
      setRemovalTarget(undefined);
    },
    onTargetUnavailable: (member) => {
      setRemovalTarget(undefined);
      notifications.info({
        title: `${member.displayName} is no longer in this workspace`,
      });
    },
  });
  const change: Proposal | undefined =
    roleCommand.activeMember !== undefined &&
    roleCommand.activeRole !== undefined
      ? { member: roleCommand.activeMember, role: roleCommand.activeRole }
      : proposal;
  const removing = removal.activeMember ?? removalTarget;
  const locked = roleCommand.locked || removal.locked;
  const canManage = workspace.capabilities.includes('member:manage');
  const actor = { role: workspace.role, userId: user.id };

  const control: MemberRowControl = {
    roles: assignableRoles(workspace.role),
    canChange: (member) => canManage && canChangeRoleOf(actor, member),
    canRemove: (member) => canManage && canRemoveMember(actor, member),
    shownRole: (member) =>
      change?.member.userId === member.userId ? change.role : member.role,
    disabled: locked,
    feedback: (member) =>
      rowFeedback(roleCommand.feedback, member, change?.member) ??
      rowFeedback(removal.feedback, member, removing),
    onPick: (member, role) => {
      if (!locked && role !== member.role) setProposal({ member, role });
    },
    onRemove: (member) => {
      if (!locked) setRemovalTarget(member);
    },
  };

  return (
    <>
      <MemberList members={members} actorUserId={user.id} control={control} />
      <MemberRoleDialog
        change={change}
        pending={roleCommand.pending}
        locked={roleCommand.locked}
        retryAvailable={roleCommand.retryAvailable}
        error={
          roleCommand.error ??
          (roleCommand.feedback?.targetUserId === change?.member.userId
            ? roleCommand.feedback?.message
            : undefined)
        }
        onClose={() => {
          setProposal(undefined);
        }}
        onConfirm={() => {
          if (proposal !== undefined)
            void roleCommand.start(proposal.member, proposal.role);
        }}
        onRetry={() => {
          void roleCommand.retry();
        }}
        onDismissUncertain={roleCommand.dismiss}
      />
      <MemberRemovalDialog
        member={removing}
        workspaceName={workspace.name}
        pending={removal.pending}
        locked={removal.locked}
        retryAvailable={removal.retryAvailable}
        error={
          removal.error ??
          (removal.feedback?.targetUserId === removing?.userId
            ? removal.feedback?.message
            : undefined)
        }
        onClose={() => {
          setRemovalTarget(undefined);
        }}
        onConfirm={() => {
          if (removalTarget !== undefined) void removal.start(removalTarget);
        }}
        onRetry={() => {
          void removal.retry();
        }}
        onDismissUncertain={removal.dismiss}
      />
    </>
  );
}
