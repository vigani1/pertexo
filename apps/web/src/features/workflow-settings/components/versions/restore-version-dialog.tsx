import type { WorkflowVersionResponse } from '@pertexo/contracts/schemas/workflow-authoring';
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
  useWorkflowVersionRestore,
  type RestoreRecovery,
} from '../../mutations/use-version-restore';

const CONFIRM: Readonly<Record<RestoreRecovery | 'start', string>> = {
  start: 'Restore draft',
  'check-outcome': 'Check again',
  'retry-original': 'Retry restore',
  'confirm-replacement': 'Replace newer draft',
};

/**
 * "Your draft will be replaced by v5." The draft is checked before and after,
 * so a newer draft is only replaced after a second, explicit confirmation.
 */
export function RestoreVersionDialog({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  version,
  onClose,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  version: WorkflowVersionResponse;
  onClose: () => void;
}>) {
  const notifications = useNotifications();
  const restore = useWorkflowVersionRestore({
    apiClient,
    userId,
    workspaceId,
    workflowId,
  });
  const label = `v${String(version.versionNumber)}`;

  async function confirm() {
    if (!(await restore.restore(version))) return;
    notifications.success({
      title: `Draft restored from ${label}`,
      description: 'Open Build to review it, then publish when ready.',
    });
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open || restore.pending) return;
        restore.dismiss();
        onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Restore {label} to the draft?</DialogTitle>
        <DialogDescription>
          Your draft will be replaced by {label}. Published versions don’t
          change.
        </DialogDescription>
        {restore.error === undefined ? null : (
          <p
            role="alert"
            className={
              restore.recovery === undefined
                ? 'mt-4 text-sm text-destructive'
                : 'mt-4 text-sm text-warning'
            }
          >
            {restore.error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <DialogClose
            render={
              <Button
                type="button"
                variant="ghost"
                disabled={restore.pending}
              />
            }
          >
            Cancel
          </DialogClose>
          <Button
            type="button"
            variant={
              restore.recovery === 'confirm-replacement'
                ? 'destructive'
                : 'default'
            }
            disabled={restore.pending}
            onClick={() => void confirm()}
          >
            {restore.pending ? <LoadingOrb /> : null}
            {restore.pending
              ? 'Restoring…'
              : CONFIRM[restore.recovery ?? 'start']}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
