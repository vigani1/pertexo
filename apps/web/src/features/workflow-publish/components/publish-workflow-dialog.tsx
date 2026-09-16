import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

export function PublishWorkflowDialog({
  open,
  pending,
  error,
  recoveryPending,
  onOpenChange,
  onPublish,
}: Readonly<{
  open: boolean;
  pending: boolean;
  error: string | undefined;
  recoveryPending: boolean;
  onOpenChange: (open: boolean) => void;
  onPublish: () => void;
}>) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogTitle>Publish saved workflow?</DialogTitle>
        <DialogDescription>
          {recoveryPending
            ? 'Retrying recovers the original publish command with its saved draft precondition and command key. Newer edits are not substituted.'
            : 'Publishing creates an immutable version from the exact saved draft. A stale or invalid validation cannot be used.'}
        </DialogDescription>
        {error ? (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <DialogClose
            render={<Button type="button" variant="ghost" disabled={pending} />}
          >
            Cancel
          </DialogClose>
          <Button type="button" disabled={pending} onClick={onPublish}>
            {pending
              ? 'Publishing…'
              : recoveryPending
                ? 'Retry original publish'
                : error
                  ? 'Try publish again'
                  : 'Publish version'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
