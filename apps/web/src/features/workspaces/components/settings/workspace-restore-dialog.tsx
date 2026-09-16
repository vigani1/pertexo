import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useState } from 'react';

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
  error?: string;
  retryAvailable: boolean;
  onDismissUncertain: () => void;
  onRestore: () => Promise<boolean>;
  onRetry: () => Promise<boolean>;
}>) {
  const [open, setOpen] = useState(false);

  function changeOpen(next: boolean) {
    if (!next && retryAvailable) return;
    setOpen(next);
  }

  async function submit() {
    const accepted = await (retryAvailable ? onRetry() : onRestore());
    if (accepted) changeOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button type="button" variant="outline" />}>
        Restore workspace
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Restore this workspace?</DialogTitle>
        <DialogDescription>
          Cancel deletion for {workspaceName}. A completed restore returns the
          workspace to suspended state; it does not reactivate other resources.
        </DialogDescription>
        {error === undefined ? null : (
          <p role="alert" className="mt-5 text-sm text-destructive">
            {error}
          </p>
        )}
        {retryAvailable ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Retry uses the same command key because the previous result is
            uncertain.
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          {retryAvailable ? (
            <Button type="button" variant="ghost" onClick={onDismissUncertain}>
              Dismiss attempt
            </Button>
          ) : (
            <DialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </DialogClose>
          )}
          <Button
            type="button"
            disabled={pending}
            onClick={() => {
              void submit();
            }}
          >
            {pending
              ? 'Submitting…'
              : retryAvailable
                ? 'Retry restore'
                : 'Restore workspace'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
