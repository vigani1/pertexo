import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import {
  runCancellationError,
  useRunCancellation,
} from '../../mutations/use-run-cancellation';

/**
 * Stopping a run is destructive, so it asks first. The outcome is reported
 * as a toast: stopping, already stopping, or why it couldn't.
 */
export function CancelRunDialog({
  apiClient,
  userId,
  workspaceId,
  runId,
  workflowName,
  open,
  onOpenChange,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  runId: string;
  workflowName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>) {
  const notifications = useNotifications();
  const cancellation = useRunCancellation({
    apiClient,
    userId,
    workspaceId,
    runId,
  });

  function stop() {
    cancellation.mutate(undefined, {
      onSuccess: (response) => {
        onOpenChange(false);
        if (response.alreadyRequested)
          notifications.info({
            title: 'This run is already stopping',
            description: `${workflowName} will stop after its current step.`,
          });
        else
          notifications.success({
            title: 'Stopping the run',
            description: `${workflowName} stops after its current step.`,
          });
      },
      onError: (error) => {
        onOpenChange(false);
        notifications.error({
          title: 'The run didn’t stop',
          description: runCancellationError(error),
        });
      },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!cancellation.isPending) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogTitle>Stop this run?</DialogTitle>
        <DialogDescription>
          Steps that already finished aren’t undone. {workflowName} stops after
          the step it’s on now.
        </DialogDescription>
        <div className="mt-7 flex justify-end gap-2">
          <DialogClose
            render={
              <Button
                type="button"
                variant="ghost"
                disabled={cancellation.isPending}
              />
            }
          >
            Keep running
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={cancellation.isPending}
            onClick={stop}
          >
            {cancellation.isPending ? (
              <>
                <LoadingOrb />
                Stopping…
              </>
            ) : (
              'Stop run'
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
