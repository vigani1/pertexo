import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { useState } from 'react';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { Button } from '@/components/ui/button';

/** Restoring cancels the deletion; the dialog says what stays off afterwards. */
export function WorkspaceRestoreDialog({
  workspaceName,
  pending,
  error,
  retryAvailable,
  onDismissUncertain,
  onRestore,
  onRetry,
}: Readonly<{
  workspaceName: string;
  pending: boolean;
  error: string | undefined;
  retryAvailable: boolean;
  onDismissUncertain: () => void;
  onRestore: () => Promise<boolean>;
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
      title={`Restore ${workspaceName}?`}
      description="This cancels the deletion. The workspace comes back suspended: people can sign in and look around, but triggers and integrations stay off until their connections are reconnected."
      trigger={
        <Button type="button" variant="default">
          Restore workspace
        </Button>
      }
      onSubmit={confirmationRetry?.onRetry ?? (() => send(onRestore))}
      submitDisabled={pending}
      footer={
        <ConfirmationFooter>
          {confirmationRetry === undefined ? (
            <DialogClose
              disabled={pending || retryAvailable}
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
                setOpen(false);
              }}
            >
              Close
            </Button>
          )}
          <ProgressButton
            type="submit"
            variant="primary"
            pending={pending}
            pendingLabel="Restoring…"
          >
            {confirmationRetry === undefined
              ? 'Restore workspace'
              : 'Try again'}
          </ProgressButton>
        </ConfirmationFooter>
      }
    >
      <ConfirmationDetails
        error={error}
        tone={confirmationRetry === undefined ? 'destructive' : 'warning'}
      />
    </ConfirmDialog>
  );
}
