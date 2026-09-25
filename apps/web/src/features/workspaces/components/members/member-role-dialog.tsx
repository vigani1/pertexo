import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import {
  ROLE_SUMMARIES,
  firstNameOf,
  withArticle,
  type ManagedRole,
} from '../../model/workspace-roles';
import {
  MemberCommandDialog,
  type MemberCommandView,
} from './member-command-dialog';

/**
 * Confirms a role change. The person is signed out everywhere so their next
 * sign-in carries the new role; that is said before anything is sent.
 */
export function MemberRoleDialog(
  props: Readonly<{
    change:
      Readonly<{ member: WorkspaceMember; role: ManagedRole }> | undefined;
    command: MemberCommandView;
    onClose: () => void;
    onConfirm: () => void;
  }>,
) {
  const { change } = props;
  return (
    <MemberCommandDialog
      member={change?.member}
      command={props.command}
      onClose={props.onClose}
      onConfirm={props.onConfirm}
      title={`Make ${change?.member.displayName ?? 'this member'} ${
        change === undefined ? 'a new role' : withArticle(change.role)
      }?`}
      description={`${change === undefined ? '' : ROLE_SUMMARIES[change.role]} ${firstNameOf(change?.member)} will be signed out everywhere and signs in again with the new role.`}
      confirmLabel="Change role"
      pendingLabel="Changing…"
    />
  );
}
