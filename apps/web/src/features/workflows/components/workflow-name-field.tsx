import { PencilIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { InlineRename } from '@/components/patterns/inline-rename';
import { Button } from '@/components/ui/button';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { canRenameWorkflow, workflowNameError } from '../model/workflow-rename';
import { useWorkflowRename } from '../workflows.mutations';
import { WorkflowRenameDialog } from './workflow-rename-dialog';

type WorkflowNameProps = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  /** Layout of the editing form, e.g. a row in the hub bar. */
  className?: string;
  /** How the name reads when not editing. */
  children: ReactNode;
}>;

function EditableWorkflowName({
  apiClient,
  userId,
  workspace,
  workflow,
  className,
  children,
}: WorkflowNameProps) {
  const notifications = useNotifications();
  const command = useWorkflowRename({
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId: workflow.id,
    onRenamed: (name) => {
      notifications.success({ title: `Renamed to ${name}` });
    },
  });
  return (
    <InlineRename
      name={workflow.name}
      revision={workflow.nameRevision}
      subject="workflow"
      label="Workflow name"
      validate={workflowNameError}
      command={command}
      onSave={command.start}
      {...(className === undefined ? {} : { className })}
    >
      {children}
    </InlineRename>
  );
}

/**
 * The workflow's name, with a pencil for people who may rename it: editors
 * of an active workflow. Everyone else reads `children` as it is.
 */
export function WorkflowNameField(props: WorkflowNameProps) {
  return canRenameWorkflow(props.workspace, props.workflow) ? (
    <EditableWorkflowName {...props} />
  ) : (
    props.children
  );
}

/**
 * The name in a bar that can't grow: the pencil opens the rename dialog
 * instead of editing in place, so the bar keeps its height and its tabs.
 */
export function WorkflowNameWithDialog({
  apiClient,
  userId,
  workspace,
  workflow,
  children,
}: Omit<WorkflowNameProps, 'className'>) {
  const [renaming, setRenaming] = useState(false);
  if (!canRenameWorkflow(workspace, workflow)) return children;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {children}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Rename workflow"
        onClick={() => {
          setRenaming(true);
        }}
      >
        <PencilIcon aria-hidden="true" />
      </Button>
      {renaming ? (
        <WorkflowRenameDialog
          apiClient={apiClient}
          userId={userId}
          workspaceId={workspace.id}
          workflow={workflow}
          onClose={() => {
            setRenaming(false);
          }}
        />
      ) : null}
    </div>
  );
}
