import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import {
  LIFECYCLE_CONSEQUENCES,
  type LifecycleIntent,
} from '../model/workflow-lifecycle';
import { useWorkflowLifecycleCommand } from '../workflows.mutations';

const COPY = {
  archive: {
    title: 'Archive this workflow?',
    confirm: 'Archive',
    pending: 'Archiving…',
    done: 'Workflow archived',
  },
  restore: {
    title: 'Restore this workflow?',
    confirm: 'Restore',
    pending: 'Restoring…',
    done: 'Workflow restored',
  },
} as const;

/**
 * Confirms archive or restore with its consequences spelled out. The intent
 * stays fixed while open, so a retry repeats exactly what was confirmed.
 */
export function WorkflowLifecycleDialog({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  workflowName,
  intent,
  onCompleted,
  onClose,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  workflowName: string;
  intent: LifecycleIntent | undefined;
  /** Called once the change is confirmed, before the dialog closes. */
  onCompleted?: (() => void) | undefined;
  onClose: () => void;
}>) {
  const notifications = useNotifications();
  const lifecycle = useWorkflowLifecycleCommand({
    apiClient,
    userId,
    workspaceId,
    workflowId,
  });
  const action = intent?.command ?? 'archive';
  const copy = COPY[action];

  async function confirm() {
    if (intent === undefined) return;
    const done = await lifecycle.submit(
      intent.command,
      intent.expectedLifecycleRevision,
    );
    if (!done) return;
    notifications.success({ title: copy.done, description: workflowName });
    onCompleted?.();
    onClose();
  }

  return (
    <ConfirmDialog
      open={intent !== undefined}
      onOpenChange={(open) => {
        if (open) return;
        lifecycle.reset();
        onClose();
      }}
      title={copy.title}
      description={
        <span className="font-medium text-foreground">{workflowName}</span>
      }
      consequences={LIFECYCLE_CONSEQUENCES[action]}
      tone={action === 'restore' ? 'default' : 'destructive'}
      confirmLabel={lifecycle.exactRetry ? 'Retry safely' : copy.confirm}
      pendingLabel={copy.pending}
      pending={lifecycle.pending}
      error={lifecycle.error}
      errorTone={lifecycle.exactRetry ? 'warning' : 'destructive'}
      onConfirm={confirm}
    />
  );
}
