import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import {
  allowlistedReturnPath,
  returnToSearch,
} from '@/features/auth/return-path.public';
import { firstNameOf } from '../../model/workspace-roles';
import { feedbackFor } from '../../mutations/use-member-command';
import {
  MemberCommandDialog,
  type MemberCommandView,
} from './member-command-dialog';

/**
 * Confirms handing the workspace to another member (ADR 047). Every
 * consequence is spelled out first; when the server wants a fresh sign-in,
 * the failure offers one that comes back to Team.
 */
export function OwnershipTransferDialog(
  props: Readonly<{
    member: WorkspaceMember | undefined;
    workspaceId: string;
    workspaceName: string;
    command: MemberCommandView;
    onClose: () => void;
    onConfirm: () => void;
  }>,
) {
  const { member } = props;
  const firstName = firstNameOf(member);
  const freshSignIn =
    feedbackFor(props.command.feedback, member)?.freshSignIn === true;
  return (
    <MemberCommandDialog
      member={member}
      command={props.command}
      onClose={props.onClose}
      onConfirm={props.onConfirm}
      tone="destructive"
      title={`Make ${member?.displayName ?? 'this member'} the owner of ${props.workspaceName}?`}
      consequences={[
        `${firstName} becomes the owner: the only person who can rename, delete or hand over this workspace.`,
        'You become an admin. You keep managing members and connections, but only the new owner can make you the owner again.',
        `You and ${firstName} are both signed out everywhere and sign in again.`,
        'A workspace has one owner, and the owner can’t leave until they hand it over.',
        'For your security, this needs a sign-in from the last five minutes.',
      ]}
      confirmLabel="Make owner"
      pendingLabel="Handing over…"
      errorAction={
        freshSignIn ? (
          <Link
            to="/logout"
            search={returnToSearch(
              allowlistedReturnPath(`/w/${props.workspaceId}/team`),
            )}
            className="text-[0.8rem] font-semibold text-accent-foreground underline-offset-4 hover:underline"
          >
            Sign in again
          </Link>
        ) : undefined
      }
    />
  );
}
