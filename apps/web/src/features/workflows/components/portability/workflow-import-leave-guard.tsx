import { useBlocker } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

/** Keep an unresolved command's owner alive, not the dialog's presentation. */
export function WorkflowImportLeaveGuard({
  workspaceId,
  unresolved,
  onReopen,
}: Readonly<{
  workspaceId: string;
  unresolved: boolean;
  onReopen: () => void;
}>) {
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      unresolved &&
      current.pathname !== next.pathname &&
      (next.pathname === `/w/${workspaceId}` ||
        next.pathname.startsWith(`/w/${workspaceId}/`)),
    enableBeforeUnload: unresolved,
    withResolver: true,
  });
  useEffect(() => {
    if (!unresolved && blocker.status === 'blocked') blocker.proceed();
  }, [unresolved, blocker]);
  return (
    <Dialog
      open={blocker.status === 'blocked'}
      onOpenChange={(open) => {
        if (!open && blocker.status === 'blocked') blocker.reset();
      }}
    >
      <DialogContent>
        <DialogTitle>Resolve the import before leaving</DialogTitle>
        <DialogDescription>
          This import may already have created a workflow. Stay here and recover
          the exact command before opening another page in this workspace. You
          can dismiss its dialog without losing recovery. Closing or reloading
          the browser discards this in-memory recovery.
        </DialogDescription>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              if (blocker.status === 'blocked') blocker.reset();
            }}
          >
            Stay here
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (blocker.status === 'blocked') blocker.reset();
              onReopen();
            }}
          >
            Reopen import
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
