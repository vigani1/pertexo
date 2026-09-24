import type { WorkflowVersionResponse } from '@pertexo/contracts/schemas/workflow-authoring';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
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
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (open) return;
        restore.dismiss();
        onClose();
      }}
      title={`Restore ${label} to the draft?`}
      description={`Your draft will be replaced by ${label}. Published versions don’t change.`}
      tone={
        restore.recovery === 'confirm-replacement' ? 'destructive' : 'default'
      }
      confirmLabel={CONFIRM[restore.recovery ?? 'start']}
      pendingLabel="Restoring…"
      pending={restore.pending}
      error={restore.error}
      errorTone={restore.recovery === undefined ? 'destructive' : 'warning'}
      onConfirm={confirm}
    />
  );
}
