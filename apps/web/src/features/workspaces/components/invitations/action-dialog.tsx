import type { WorkspaceInvitation } from '@pertexo/contracts';
import {
  ConfirmDialog,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
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
    command: Readonly<{
      pending: boolean;
      locked: boolean;
      retryAvailable: boolean;
      message: string | undefined;
      onConfirm: () => void;
      onRetry: () => void;
      onDismiss: () => void;
    }>;
    onClose: () => void;
  }>,
) {
  const copy = COPY[props.selection?.action ?? 'resend'];
  const changeConfirmationOpen = (open: boolean) => {
    if (!open) props.onClose();
  };
  const confirmationRetry = props.command.retryAvailable
    ? { onRetry: props.command.onRetry, onDismiss: props.command.onDismiss }
    : undefined;
  return (
    <ConfirmDialog
      state={{
        open: props.selection !== undefined,
        onOpenChange: changeConfirmationOpen,
        locked: props.command.locked,
      }}
      title={copy.title(props.selection?.invitation.email ?? 'this person')}
      description={copy.description}
      onSubmit={confirmationRetry?.onRetry ?? props.command.onConfirm}
      submitDisabled={props.command.pending}
      actions={{
        cancel:
          confirmationRetry === undefined
            ? {
                kind: 'close',
                label: 'Cancel',
                variant: 'ghost',
                disabled: props.command.locked,
              }
            : {
                kind: 'action',
                label: 'Close',
                variant: 'ghost',
                onClick: () => {
                  confirmationRetry.onDismiss();
                  changeConfirmationOpen(false);
                },
              },
        confirm: {
          label: confirmationRetry === undefined ? copy.confirm : 'Try again',
          type: 'submit',
          variant:
            (props.selection?.action === 'revoke'
              ? 'destructive'
              : 'default') === 'destructive'
              ? 'destructive'
              : 'primary',
          pending: props.command.pending,
          pendingLabel: copy.busy,
        },
      }}
    >
      <ConfirmationDetails
        error={props.command.message}
        tone={confirmationRetry === undefined ? 'destructive' : 'warning'}
      />
    </ConfirmDialog>
  );
}
