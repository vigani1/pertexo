import type { ReactNode } from 'react';
import type { WorkspaceMember } from '@pertexo/contracts';
import {
  ConfirmDialog,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import {
  feedbackFor,
  type MemberCommandFeedback,
} from '../../data/mutations/members/use-member-command';
/** The state of one member command that its confirmation shows. */
export type MemberCommandView = Readonly<{
  pending: boolean;
  locked: boolean;
  feedback: MemberCommandFeedback | undefined;
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
  return (
    <ConfirmDialog
      state={{
        open: member !== undefined,
        onOpenChange: changeConfirmationOpen,
        locked: command.locked,
      }}
      title={content.title}
      description={content.description}
      onSubmit={onConfirm}
      submitDisabled={command.pending || member === undefined}
      actions={{
        cancel: {
          kind: 'close',
          label: 'Cancel',
          variant: 'ghost',
          disabled: command.locked,
        },
        confirm: {
          label: content.confirmLabel,
          type: 'submit',
          variant:
            (content.tone ?? 'default') === 'destructive'
              ? 'destructive'
              : 'primary',
          pending: command.pending,
          pendingLabel: content.pendingLabel ?? content.confirmLabel,
          disabled: member === undefined,
        },
      }}
    >
      <ConfirmationDetails
        consequences={content.consequences}
        error={feedbackFor(command.feedback, member)?.message}
        tone="destructive"
        errorAction={content.errorAction}
      />
    </ConfirmDialog>
  );
}
