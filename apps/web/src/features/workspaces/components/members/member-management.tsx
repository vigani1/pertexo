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
  canSuspendMember,
  canTransferOwnershipTo,
  withArticle,
  type ManagedRole,
  type WorkspaceRole,
} from '../../model/workspace-roles';
import type { MemberCommandFeedback } from '../../mutations/use-member-command';
import { useMemberRemovalCommand } from '../../mutations/use-member-removal-command';
import { useMemberRoleCommand } from '../../mutations/use-member-role-command';
import {
  statusChangeDone,
  useMemberStatusCommand,
  type MemberStatusDirection,
} from '../../mutations/use-member-status-command';
import { useOwnershipTransferCommand } from '../../mutations/use-ownership-transfer-command';
import {
  MemberList,
  type MemberAction,
  type MemberRowControl,
} from './member-list';
import { MemberRemovalDialog } from './member-removal-dialog';
import { MemberRoleDialog } from './member-role-dialog';
import { MemberStatusDialog } from './member-status-dialog';
import { OwnershipTransferDialog } from './ownership-transfer-dialog';

type Proposal = Readonly<{ member: WorkspaceMember; role: ManagedRole }>;
type StatusChange = Readonly<{
  member: WorkspaceMember;
  direction: MemberStatusDirection;
}>;
type AccessLoss = 'authentication' | 'permission';
type Actor = Readonly<{ role: WorkspaceRole; userId: string }>;

/** Row feedback belongs to the member it is about, while no dialog shows it. */
function rowFeedback(
  feedback: MemberCommandFeedback | undefined,
  member: WorkspaceMember,
  shownInDialog: WorkspaceMember | undefined,
): string | undefined {
  return feedback?.targetUserId === member.userId &&
    shownInDialog?.userId !== member.userId
    ? feedback.message
    : undefined;
}

/** The actions menu for a member; transfer needs the actor's own row. */
function memberActions(
  actor: Actor,
  you: WorkspaceMember | undefined,
  member: WorkspaceMember,
): readonly MemberAction[] {
  const actions: MemberAction[] = [];
  if (you !== undefined && canTransferOwnershipTo(actor, member))
    actions.push('transfer');
  if (canSuspendMember(actor, member))
    actions.push(
      member.membershipStatus === 'suspended' ? 'reactivate' : 'suspend',
    );
  if (canRemoveMember(actor, member)) actions.push('remove');
  return actions;
}

/**
 * Members with an inline role picker and an actions menu: make owner,
 * suspend or reactivate, and remove. Choosing only proposes; the
 * confirmation sends it, and an in-flight or unconfirmed command keeps its
 * confirmation on its original member.
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
  const [statusChange, setStatusChange] = useState<StatusChange>();
  const [transferTarget, setTransferTarget] = useState<WorkspaceMember>();
  const gone = (member: WorkspaceMember) => {
    notifications.info({
      title: `${member.displayName} is no longer in this workspace`,
    });
  };
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
      gone(member);
    },
  });
  const status = useMemberStatusCommand({
    ...scope,
    onChanged: (member, direction) => {
      setStatusChange(undefined);
      notifications.success({
        title: `${member.displayName} was ${statusChangeDone(direction)}`,
      });
    },
    onConflict: () => {
      setStatusChange(undefined);
    },
    onTargetUnavailable: (member) => {
      setStatusChange(undefined);
      gone(member);
    },
  });
  const transfer = useOwnershipTransferCommand({
    ...scope,
    onTransferred: (member) => {
      setTransferTarget(undefined);
      notifications.success({
        title: `${member.displayName} is now the owner of ${workspace.name}`,
        description: 'You’re an admin now. Sign in again to keep working.',
      });
      onAccessLost('authentication');
    },
    onConflict: () => {
      setTransferTarget(undefined);
    },
    onTargetUnavailable: (member) => {
      setTransferTarget(undefined);
      gone(member);
    },
  });
  const change: Proposal | undefined =
    roleCommand.activeMember !== undefined &&
    roleCommand.activeRole !== undefined
      ? { member: roleCommand.activeMember, role: roleCommand.activeRole }
      : proposal;
  const removing = removal.activeMember ?? removalTarget;
  const statusShown: StatusChange | undefined =
    status.activeMember !== undefined && status.activeDirection !== undefined
      ? { member: status.activeMember, direction: status.activeDirection }
      : statusChange;
  const transferring = transfer.activeMember ?? transferTarget;
  const locked =
    roleCommand.locked || removal.locked || status.locked || transfer.locked;
  const canManage = workspace.capabilities.includes('member:manage');
  const actor = { role: workspace.role, userId: user.id };
  const you = members.find((member) => member.userId === user.id);

  const control: MemberRowControl = {
    roles: assignableRoles(workspace.role),
    canChange: (member) => canManage && canChangeRoleOf(actor, member),
    actions: (member) => (canManage ? memberActions(actor, you, member) : []),
    shownRole: (member) =>
      change?.member.userId === member.userId ? change.role : member.role,
    disabled: locked,
    feedback: (member) =>
      rowFeedback(roleCommand.feedback, member, change?.member) ??
      rowFeedback(removal.feedback, member, removing) ??
      rowFeedback(status.feedback, member, statusShown?.member) ??
      rowFeedback(transfer.feedback, member, transferring),
    onPick: (member, role) => {
      if (!locked && role !== member.role) setProposal({ member, role });
    },
    onAction: (member, action) => {
      if (locked) return;
      if (action === 'remove') setRemovalTarget(member);
      else if (action === 'transfer') setTransferTarget(member);
      else setStatusChange({ member, direction: action });
    },
  };

  return (
    <>
      <MemberList members={members} actorUserId={user.id} control={control} />
      <MemberRoleDialog
        change={change}
        command={roleCommand}
        onClose={() => {
          setProposal(undefined);
        }}
        onConfirm={() => {
          if (proposal !== undefined)
            void roleCommand.start(proposal.member, proposal.role);
        }}
      />
      <MemberRemovalDialog
        member={removing}
        workspaceName={workspace.name}
        command={removal}
        onClose={() => {
          setRemovalTarget(undefined);
        }}
        onConfirm={() => {
          if (removalTarget !== undefined) void removal.start(removalTarget);
        }}
      />
      <MemberStatusDialog
        change={statusShown}
        workspaceName={workspace.name}
        command={status}
        onClose={() => {
          setStatusChange(undefined);
        }}
        onConfirm={() => {
          if (statusChange !== undefined)
            void status.start(statusChange.member, statusChange.direction);
        }}
      />
      <OwnershipTransferDialog
        member={transferring}
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        command={transfer}
        onClose={() => {
          setTransferTarget(undefined);
        }}
        onConfirm={() => {
          if (transferTarget !== undefined && you !== undefined)
            void transfer.start(transferTarget, you);
        }}
      />
    </>
  );
}
