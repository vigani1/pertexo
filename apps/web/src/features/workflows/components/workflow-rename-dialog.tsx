import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { useQuery } from '@tanstack/react-query';
import { RenameForm } from '@/components/patterns/inline-rename';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { workflowNameError } from '../model/workflow-rename';
import { workflowSummaryQueryOptions } from '../workflows.queries';
import { useWorkflowRename } from '../workflows.mutations';

/**
 * Renames a workflow from its row. The form reads the workflow's current
 * name and revision, so a rename made elsewhere meanwhile is offered as
 * "Use theirs / Keep mine" rather than overwritten.
 */
export function WorkflowRenameDialog({
  apiClient,
  userId,
  workspaceId,
  workflow,
  onClose,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  /** The row's summary, shown until the current one loads. */
  workflow: WorkflowSummary;
  onClose: () => void;
}>) {
  const notifications = useNotifications();
  const summary = useQuery({
    ...workflowSummaryQueryOptions(apiClient, userId, workspaceId, workflow.id),
    placeholderData: workflow,
  });
  const current = summary.data ?? workflow;
  const command = useWorkflowRename({
    apiClient,
    userId,
    workspaceId,
    workflowId: workflow.id,
    onRenamed: (name) => {
      notifications.success({ title: `Renamed to ${name}` });
    },
  });
  const locked = command.pending || command.retryAvailable;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open || locked) return;
        command.clearError();
        onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Rename workflow</DialogTitle>
        <DialogDescription>
          The new name shows wherever this workflow appears, including its past
          runs. Versions, triggers and runs stay as they are.
        </DialogDescription>
        <RenameForm
          className="mt-5 max-w-none"
          name={current.name}
          revision={current.nameRevision}
          subject="workflow"
          label="Workflow name"
          validate={workflowNameError}
          command={command}
          onSave={command.start}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
