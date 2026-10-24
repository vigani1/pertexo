import type { WorkflowSummary } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { WorkflowLifecycleDialog } from '../../workflow-lifecycle-dialog';
import { WorkflowRenameDialog } from '../../workflow-rename-dialog';
import type { LifecycleIntent } from '../../../model/lifecycle';

export type LifecycleTarget = Readonly<{
  workflow: WorkflowSummary;
  intent: LifecycleIntent;
}>;

/** Renaming or archiving/restoring one workflow, over the list. */
export function WorkflowDialogs({
  apiClient,
  userId,
  workspaceId,
  renaming,
  lifecycle,
  onRenameClose,
  onLifecycleClose,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  renaming: WorkflowSummary | undefined;
  lifecycle: LifecycleTarget | undefined;
  onRenameClose: () => void;
  onLifecycleClose: () => void;
}>) {
  return (
    <>
      {renaming === undefined ? null : (
        <WorkflowRenameDialog
          key={renaming.id}
          apiClient={apiClient}
          userId={userId}
          workspaceId={workspaceId}
          workflow={renaming}
          onClose={onRenameClose}
        />
      )}
      {lifecycle === undefined ? null : (
        <WorkflowLifecycleDialog
          key={lifecycle.workflow.id}
          apiClient={apiClient}
          userId={userId}
          workspaceId={workspaceId}
          workflowId={lifecycle.workflow.id}
          workflowName={lifecycle.workflow.name}
          intent={lifecycle.intent}
          onClose={onLifecycleClose}
        />
      )}
    </>
  );
}
