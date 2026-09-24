import { useState } from 'react';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
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

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      locked={pending || retryAvailable}
      trigger={
        <Button type="button" variant="default">
          Restore workspace
        </Button>
      }
      title={`Restore ${workspaceName}?`}
      description="This cancels the deletion. The workspace comes back suspended: people can sign in and look around, but triggers and integrations stay off until their connections are reconnected."
      confirmLabel="Restore workspace"
      pendingLabel="Restoring…"
      pending={pending}
      error={error}
      onConfirm={() => send(onRestore)}
      unconfirmed={
        retryAvailable
          ? { onRetry: () => send(onRetry), onDismiss: onDismissUncertain }
          : undefined
      }
    />
  );
}
