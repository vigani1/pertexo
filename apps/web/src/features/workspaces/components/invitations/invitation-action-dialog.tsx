import type { WorkspaceInvitation } from '@pertexo/contracts/schemas/identity-workspace';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Notice } from '@/components/ui/notice';
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
    <Dialog
      open={props.selection !== undefined}
      onOpenChange={(open) => {
        if (!open && !props.locked) props.onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>
          {copy.title(props.selection?.invitation.email ?? 'this person')}
        </DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
        {props.message === undefined ? null : (
          <Notice
            role="alert"
            tone={props.retryAvailable ? 'warning' : 'destructive'}
            className="mt-5"
          >
            {props.message}
          </Notice>
        )}
        <div className="mt-6 flex justify-end gap-2">
          {props.retryAvailable ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                props.onDismiss();
                props.onClose();
              }}
            >
              Close
            </Button>
          ) : (
            <DialogClose
              disabled={props.locked}
              render={<Button type="button" variant="ghost" />}
            >
              Cancel
            </DialogClose>
          )}
          <Button
            type="button"
            variant={
              props.selection?.action === 'revoke' ? 'destructive' : 'primary'
            }
            disabled={props.pending}
            onClick={props.retryAvailable ? props.onRetry : props.onConfirm}
          >
            {props.pending ? <LoadingOrb data-icon="inline-start" /> : null}
            {props.pending
              ? copy.busy
              : props.retryAvailable
                ? 'Try again'
                : copy.confirm}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
