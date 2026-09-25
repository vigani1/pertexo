import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
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

  async function stop() {
    // The run's cache changes on success and can take this dialog with it;
    // the outcome toast follows the awaited command, not a mutate callback.
    try {
      const response = await cancellation.mutateAsync();
      onOpenChange(false);
      if (response.alreadyRequested)
        notifications.info({
          title: 'This run is already being canceled',
          description: `${workflowName} stops after its current step.`,
        });
      else
        notifications.success({
          title: 'Canceling the run',
          description: `${workflowName} stops after its current step.`,
        });
    } catch (error) {
      onOpenChange(false);
      notifications.error({
        title: 'The run wasn’t canceled',
        description: runCancellationError(error),
      });
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Cancel this run?"
      description={`Steps that already finished aren’t undone. ${workflowName} stops after the step it’s on now.`}
      tone="destructive"
      confirmLabel="Cancel run"
      pendingLabel="Canceling…"
      cancelLabel="Keep running"
      pending={cancellation.isPending}
      onConfirm={stop}
    />
  );
}
