import { PencilIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { canRenameWorkflow } from '../model/rename';
import { WorkflowRenameDialog } from './workflow-rename-dialog';

type WorkflowNameProps = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  /** How the name reads when not editing. */
  children: ReactNode;
}>;

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
}: WorkflowNameProps) {
  const [renaming, setRenaming] = useState(false);
  if (!canRenameWorkflow(workspace, workflow)) return children;
  return (
    <div className="relative flex min-w-0 items-center gap-1.5">
      {children}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Rename workflow"
        className="max-sm:absolute max-sm:inset-0 max-sm:size-auto"
        onClick={() => {
          setRenaming(true);
        }}
      >
        <PencilIcon aria-hidden="true" className="max-sm:hidden" />
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
