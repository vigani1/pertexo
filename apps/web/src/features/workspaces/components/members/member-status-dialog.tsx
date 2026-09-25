import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import {
  ROLE_NAMES,
  firstNameOf,
  withArticle,
} from '../../model/workspace-roles';
import type { MemberStatusDirection } from '../../mutations/use-member-status-command';
import {
  MemberCommandDialog,
  type MemberCommandView,
} from './member-command-dialog';

function suspensionCopy(
  member: WorkspaceMember | undefined,
  workspace: string,
) {
  const firstName = firstNameOf(member);
  return {
    title: `Suspend ${member?.displayName ?? 'this member'}?`,
    consequences: [
      `${firstName} can’t open ${workspace} or its workflows, runs and connections until someone reactivates them.`,
      `${firstName} is signed out everywhere, including other workspaces, and signs in again.`,
      `They stay on the team as suspended and keep the ${member === undefined ? '' : ROLE_NAMES[member.role]} role for when they come back.`,
      'Runs they already started keep going, and invitations they sent stay pending.',
    ],
    confirmLabel: 'Suspend member',
    pendingLabel: 'Suspending…',
    tone: 'destructive' as const,
  };
}

function reactivationCopy(
  member: WorkspaceMember | undefined,
  workspace: string,
) {
  const firstName = firstNameOf(member);
  return {
    title: `Reactivate ${member?.displayName ?? 'this member'}?`,
    consequences: [
      `${firstName} gets ${workspace} back as ${member === undefined ? 'before' : withArticle(member.role)}.`,
      `${firstName} is signed out everywhere and signs in again to pick up the access.`,
    ],
    confirmLabel: 'Reactivate member',
    pendingLabel: 'Reactivating…',
    tone: 'default' as const,
  };
}

/**
 * Confirms suspending or reactivating a member (ADR 047), saying what
 * happens to their access and sessions before anything is sent.
 */
export function MemberStatusDialog(
  props: Readonly<{
    change:
      | Readonly<{ member: WorkspaceMember; direction: MemberStatusDirection }>
      | undefined;
    workspaceName: string;
    command: MemberCommandView;
    onClose: () => void;
    onConfirm: () => void;
  }>,
) {
  const member = props.change?.member;
  const copy =
    props.change?.direction === 'reactivate'
      ? reactivationCopy(member, props.workspaceName)
      : suspensionCopy(member, props.workspaceName);
  return (
    <MemberCommandDialog
      member={member}
      command={props.command}
      onClose={props.onClose}
      onConfirm={props.onConfirm}
      {...copy}
    />
  );
}
