import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import { firstNameOf } from '../../model/workspace-roles';
import {
  MemberCommandDialog,
  type MemberCommandView,
} from './member-command-dialog';

/**
 * Confirms removing a member, listing what happens before anything is sent.
 * An unconfirmed removal stays on its member with an exact retry.
 */
export function MemberRemovalDialog(
  props: Readonly<{
    member: WorkspaceMember | undefined;
    workspaceName: string;
    command: MemberCommandView;
    onClose: () => void;
    onConfirm: () => void;
  }>,
) {
  const { member } = props;
  const firstName = firstNameOf(member);
  return (
    <MemberCommandDialog
      member={member}
      command={props.command}
      onClose={props.onClose}
      onConfirm={props.onConfirm}
      tone="destructive"
      title={`Remove ${member?.displayName ?? 'this member'} from ${props.workspaceName}?`}
      consequences={[
        `${firstName} loses access to this workspace’s workflows, runs and connections straight away.`,
        `${firstName} is signed out everywhere, including other workspaces, and signs in again.`,
        'Runs they already started keep going, and invitations they sent stay pending.',
        'You can invite them again later.',
      ]}
      confirmLabel="Remove member"
      pendingLabel="Removing…"
    />
  );
}
