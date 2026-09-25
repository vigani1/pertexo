import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';

/**
 * Confirms removing a member, listing what happens before anything is sent.
 * An unconfirmed removal stays on its member with an exact retry.
 */
export function MemberRemovalDialog(
  props: Readonly<{
    member: WorkspaceMember | undefined;
    workspaceName: string;
    pending: boolean;
    locked: boolean;
    retryAvailable: boolean;
    error: string | undefined;
    onClose: () => void;
    onConfirm: () => void;
    onRetry: () => void;
    onDismissUncertain: () => void;
  }>,
) {
  const { member } = props;
  const name = member?.displayName ?? 'this member';
  const firstName = member?.displayName.split(/\s+/u)[0] ?? 'They';
  return (
    <ConfirmDialog
      open={member !== undefined}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      locked={props.locked}
      tone="destructive"
      title={`Remove ${name} from ${props.workspaceName}?`}
      consequences={[
        `${firstName} loses access to this workspace’s workflows, runs and connections straight away.`,
        `${firstName} is signed out everywhere, including other workspaces, and signs in again.`,
        'Runs they already started keep going, and invitations they sent stay pending.',
        'You can invite them again later.',
      ]}
      confirmLabel="Remove member"
      pendingLabel="Removing…"
      pending={props.pending}
      confirmDisabled={member === undefined}
      error={props.error}
      onConfirm={props.onConfirm}
      unconfirmed={
        props.retryAvailable
          ? { onRetry: props.onRetry, onDismiss: props.onDismissUncertain }
          : undefined
      }
    />
  );
}
