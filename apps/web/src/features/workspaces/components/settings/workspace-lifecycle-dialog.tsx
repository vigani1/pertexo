import { useState } from 'react';
import {
  ConfirmDialog,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { Button } from '@/components/ui/button';

/** Confirms a change that brings the workspace back and says what stays off. */
export function WorkspaceLifecycleDialog({
  title,
  description,
  action,
  pendingLabel,
  pending,
  error,
  retryAvailable,
  onDismissUncertain,
  onConfirm,
  onRetry,
}: Readonly<{
  title: string;
  description: string;
  action: string;
  pendingLabel: string;
  pending: boolean;
  error: string | undefined;
  retryAvailable: boolean;
  onDismissUncertain: () => void;
  onConfirm: () => Promise<boolean>;
  onRetry: () => Promise<boolean>;
}>) {
  const [open, setOpen] = useState(false);

  async function send(command: () => Promise<boolean>) {
    if (await command()) setOpen(false);
  }

  const confirmationRetry = retryAvailable
    ? { onRetry: () => send(onRetry), onDismiss: onDismissUncertain }
    : undefined;
  return (
    <ConfirmDialog
      state={{
        open: open,
        onOpenChange: setOpen,
        locked: pending || retryAvailable,
      }}
      title={title}
      description={description}
      trigger={
        <Button type="button" variant="default">
          {action}
        </Button>
      }
      onSubmit={confirmationRetry?.onRetry ?? (() => send(onConfirm))}
      submitDisabled={pending}
      actions={{
        cancel:
          confirmationRetry === undefined
            ? {
                kind: 'close',
                label: 'Cancel',
                variant: 'ghost',
                disabled: pending || retryAvailable,
              }
            : {
                kind: 'action',
                label: 'Close',
                variant: 'ghost',
                onClick: () => {
                  confirmationRetry.onDismiss();
                  setOpen(false);
                },
              },
        confirm: {
          label: confirmationRetry === undefined ? action : 'Try again',
          type: 'submit',
          variant: 'primary',
          pending: pending,
          pendingLabel: pendingLabel,
        },
      }}
    >
      <ConfirmationDetails
        error={error}
        tone={confirmationRetry === undefined ? 'destructive' : 'warning'}
      />
    </ConfirmDialog>
  );
}
