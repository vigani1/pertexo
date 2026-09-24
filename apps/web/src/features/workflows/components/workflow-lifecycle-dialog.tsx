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
    <Dialog
      open={intent !== undefined}
      onOpenChange={(open) => {
        if (open || lifecycle.pending) return;
        lifecycle.reset();
        onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription className="font-medium text-foreground">
          {workflowName}
        </DialogDescription>
        <ul className="mt-4 flex flex-col gap-2 text-sm leading-relaxed text-muted-foreground">
          {LIFECYCLE_CONSEQUENCES[action].map((line) => (
            <li key={line} className="flex gap-2.5">
              <span
                aria-hidden="true"
                className="mt-2.5 h-px w-3 shrink-0 bg-border-strong"
              />
              {line}
            </li>
          ))}
        </ul>
        {lifecycle.error === undefined ? null : (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {lifecycle.error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <DialogClose
            render={
              <Button
                type="button"
                variant="ghost"
                disabled={lifecycle.pending}
              />
            }
          >
            Cancel
          </DialogClose>
          <Button
            type="button"
            variant={action === 'restore' ? 'default' : 'destructive'}
            disabled={lifecycle.pending}
            onClick={() => void confirm()}
          >
            {lifecycle.pending ? <LoadingOrb /> : null}
            {lifecycle.pending
              ? copy.pending
              : lifecycle.exactRetry
                ? 'Retry safely'
                : copy.confirm}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
