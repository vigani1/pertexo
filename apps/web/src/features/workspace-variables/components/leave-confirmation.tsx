import { useBlocker } from '@tanstack/react-router';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';

export function VariableLeaveConfirmation({
  dirty,
  uncertain,
}: Readonly<{ dirty: boolean; uncertain: boolean }>) {
  const blocker = useBlocker({
    shouldBlockFn: () => dirty || uncertain,
    enableBeforeUnload: dirty || uncertain,
    withResolver: true,
  });
  const open = blocker.status === 'blocked';
  return (
    <ConfirmDialog
      state={{
        open,
        locked: false,
        onOpenChange: (next) => {
          if (!next && open) blocker.reset();
        },
      }}
      title="Leave unsaved variables?"
      description={
        uncertain
          ? 'The save result is unconfirmed. Leaving loses this request’s recovery. Keep editing to check its result first.'
          : 'Your variable changes have not been saved. Keep editing to save them, or discard them and leave.'
      }
      onSubmit={() => {
        if (open) blocker.proceed();
      }}
      footer={
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (open) blocker.reset();
            }}
          >
            Keep editing
          </Button>
          <Button type="submit" variant="destructive">
            Discard and leave
          </Button>
        </DialogFooter>
      }
    />
  );
}
