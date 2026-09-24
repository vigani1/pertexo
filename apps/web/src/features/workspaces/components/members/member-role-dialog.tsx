import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import {
  ROLE_SUMMARIES,
  withArticle,
  type ManagedRole,
} from '../../model/workspace-roles';

/**
 * Confirms a role change. The person is signed out everywhere so their next
 * sign-in carries the new role; that is said before anything is sent.
 */
export function MemberRoleDialog(
  props: Readonly<{
    change:
      Readonly<{ member: WorkspaceMember; role: ManagedRole }> | undefined;
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
  const { change } = props;
  const firstName = change?.member.displayName.split(/\s+/u)[0] ?? 'They';
  return (
    <ConfirmDialog
      open={change !== undefined}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      locked={props.locked}
      title={`Make ${change?.member.displayName ?? 'this member'} ${
        change === undefined ? 'a new role' : withArticle(change.role)
      }?`}
      description={`${change === undefined ? '' : ROLE_SUMMARIES[change.role]} ${firstName} will be signed out everywhere and signs in again with the new role.`}
      confirmLabel="Change role"
      pendingLabel="Changing…"
      pending={props.pending}
      confirmDisabled={change === undefined}
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
