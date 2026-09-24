import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Notice } from '@/components/ui/notice';

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

  async function submit() {
    if (await (retryAvailable ? onRetry() : onRestore())) setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || (!pending && !retryAvailable)) setOpen(next);
      }}
    >
      <DialogTrigger render={<Button type="button" variant="default" />}>
        Restore workspace
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Restore {workspaceName}?</DialogTitle>
        <DialogDescription>
          This cancels the deletion. The workspace comes back suspended: people
          can sign in and look around, but triggers and integrations stay off
          until their connections are reconnected.
        </DialogDescription>
        {error === undefined ? null : (
          <Notice
            role="alert"
            tone={retryAvailable ? 'warning' : 'destructive'}
            className="mt-5"
          >
            {error}
          </Notice>
        )}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          {retryAvailable ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onDismissUncertain();
                setOpen(false);
              }}
            >
              Close
            </Button>
          ) : (
            <DialogClose
              disabled={pending}
              render={<Button type="button" variant="ghost" />}
            >
              Cancel
            </DialogClose>
          )}
          <Button
            type="button"
            variant="primary"
            disabled={pending}
            onClick={() => {
              void submit();
            }}
          >
            {pending ? <LoadingOrb data-icon="inline-start" /> : null}
            {pending
              ? 'Restoring…'
              : retryAvailable
                ? 'Try again'
                : 'Restore workspace'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
