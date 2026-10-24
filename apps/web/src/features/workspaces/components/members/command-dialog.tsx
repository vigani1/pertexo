import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ReactNode } from 'react';
import type { WorkspaceMember } from '@pertexo/contracts';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import {
  feedbackFor,
  type MemberCommandFeedback,
} from '../../data/mutations/members/use-command';

/** The state of one member command that its confirmation shows. */
export type MemberCommandView = Readonly<{
  pending: boolean;
  locked: boolean;
  retryAvailable: boolean;
  error: string | undefined;
  feedback: MemberCommandFeedback | undefined;
  retry: () => Promise<boolean>;
  dismiss: () => void;
}>;

type Content = Readonly<{
  title: ReactNode;
  description?: ReactNode;
  consequences?: readonly string[];
  tone?: 'default' | 'destructive';
  confirmLabel: string;
  pendingLabel?: string;
  errorAction?: ReactNode;
}>;

/**
 * Confirms one member command. It stays on the member the command is about:
 * an unconfirmed command offers only its exact retry, and a failure about
 * this member shows inside the dialog.
 */
export function MemberCommandDialog({
  member,
  command,
  onClose,
  onConfirm,
  content,
}: Readonly<{
  content: Content;
  member: WorkspaceMember | undefined;
  command: MemberCommandView;
  onClose: () => void;
  onConfirm: () => void;
}>) {
  const changeConfirmationOpen = (open: boolean) => {
    if (!open) onClose();
  };
  const confirmationRetry = command.retryAvailable
    ? {
        onRetry: () => {
          void command.retry();
        },
        onDismiss: command.dismiss,
      }
    : undefined;
  return (
    <ConfirmDialog
      state={{
        open: member !== undefined,
        onOpenChange: changeConfirmationOpen,
        locked: command.locked,
      }}
      title={content.title}
      description={content.description}
      onSubmit={confirmationRetry?.onRetry ?? onConfirm}
      submitDisabled={command.pending || member === undefined}
      footer={
        <ConfirmationFooter>
          {confirmationRetry === undefined ? (
            <DialogClose
              disabled={command.locked}
              render={<Button type="button" variant="ghost" />}
            >
              Cancel
            </DialogClose>
          ) : (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                confirmationRetry.onDismiss();
                changeConfirmationOpen(false);
              }}
            >
              Close
            </Button>
          )}
          <ProgressButton
            type="submit"
            variant={
              (content.tone ?? 'default') === 'destructive'
                ? 'destructive'
                : 'primary'
            }
            pending={command.pending}
            pendingLabel={content.pendingLabel ?? content.confirmLabel}
            disabled={member === undefined}
          >
            {confirmationRetry === undefined
              ? content.confirmLabel
              : 'Try again'}
          </ProgressButton>
        </ConfirmationFooter>
      }
    >
      <ConfirmationDetails
        consequences={content.consequences}
        error={command.error ?? feedbackFor(command.feedback, member)?.message}
        tone={confirmationRetry === undefined ? 'destructive' : 'warning'}
        errorAction={content.errorAction}
      />
    </ConfirmDialog>
  );
}
