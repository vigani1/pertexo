import type { ComponentProps } from 'react';
import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import {
  feedbackFor,
  type MemberCommandFeedback,
} from '../../mutations/use-member-command';

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

type Content = Pick<
  ComponentProps<typeof ConfirmDialog>,
  | 'title'
  | 'description'
  | 'consequences'
  | 'tone'
  | 'confirmLabel'
  | 'pendingLabel'
  | 'errorAction'
>;

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
  ...content
}: Readonly<
  Content & {
    member: WorkspaceMember | undefined;
    command: MemberCommandView;
    onClose: () => void;
    onConfirm: () => void;
  }
>) {
  return (
    <ConfirmDialog
      {...content}
      open={member !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      locked={command.locked}
      pending={command.pending}
      confirmDisabled={member === undefined}
      error={command.error ?? feedbackFor(command.feedback, member)?.message}
      onConfirm={onConfirm}
      unconfirmed={
        command.retryAvailable
          ? {
              onRetry: () => {
                void command.retry();
              },
              onDismiss: command.dismiss,
            }
          : undefined
      }
    />
  );
}
