import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { WorkflowVersionResponse } from '@pertexo/contracts';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import {
  useWorkflowVersionRestore,
  type RestoreRecovery,
} from '../../data/mutations/use-version-restore';

const CONFIRM: Readonly<Record<RestoreRecovery | 'start', string>> = {
  start: 'Restore to draft',
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
    <ConfirmDialog
      state={{
        open: true,
        onOpenChange: (open) => {
          if (open) return;
          restore.dismiss();
          onClose();
        },
        locked: restore.pending,
      }}
      title={`Restore ${label} to the draft?`}
      description={`Your draft will be replaced by ${label}. Published versions don’t change.`}
      onSubmit={confirm}
      submitDisabled={restore.pending}
      footer={
        <ConfirmationFooter>
          <DialogClose
            disabled={restore.pending}
            render={<Button type="button" variant="ghost" />}
          >
            Cancel
          </DialogClose>
          <ProgressButton
            type="submit"
            variant={
              (restore.recovery === 'confirm-replacement'
                ? 'destructive'
                : 'default') === 'destructive'
                ? 'destructive'
                : 'primary'
            }
            pending={restore.pending}
            pendingLabel="Restoring…"
          >
            {CONFIRM[restore.recovery ?? 'start']}
          </ProgressButton>
        </ConfirmationFooter>
      }
    >
      <ConfirmationDetails
        error={restore.error}
        tone={restore.recovery === undefined ? 'destructive' : 'warning'}
      />
    </ConfirmDialog>
  );
}
