import type { WorkspaceInvitation } from '@pertexo/contracts/schemas/identity-workspace';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import type { InvitationAction } from './invitation-list';

export type InvitationSelection = Readonly<{
  invitation: WorkspaceInvitation;
  action: InvitationAction;
}>;

const COPY = {
  resend: {
    title: (email: string) => `Send ${email} a new link?`,
    description:
      'The old link, and any acceptance already in progress, stops working.',
    confirm: 'Send new link',
    busy: 'Sending…',
  },
  revoke: {
    title: (email: string) => `Revoke the invitation for ${email}?`,
    description: 'The link stops working. You can invite them again later.',
    confirm: 'Revoke invitation',
    busy: 'Revoking…',
  },
} as const;

/** Confirms Resend or Revoke; an unconfirmed command offers its exact retry. */
export function InvitationActionDialog(
  props: Readonly<{
    selection: InvitationSelection | undefined;
    pending: boolean;
    locked: boolean;
    retryAvailable: boolean;
    message: string | undefined;
    onClose: () => void;
    onConfirm: () => void;
    onRetry: () => void;
    onDismiss: () => void;
  }>,
) {
  const copy = COPY[props.selection?.action ?? 'resend'];
  return (
    <ConfirmDialog
      open={props.selection !== undefined}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      locked={props.locked}
      title={copy.title(props.selection?.invitation.email ?? 'this person')}
      description={copy.description}
      tone={props.selection?.action === 'revoke' ? 'destructive' : 'default'}
      confirmLabel={copy.confirm}
      pendingLabel={copy.busy}
      pending={props.pending}
      error={props.message}
      onConfirm={props.onConfirm}
      unconfirmed={
        props.retryAvailable
          ? { onRetry: props.onRetry, onDismiss: props.onDismiss }
          : undefined
      }
    />
  );
}
