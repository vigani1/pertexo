import type { ComponentProps } from 'react';
import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import type { DialogContent } from '@/components/ui/dialog';
import type { ApiClient } from '@/lib/api/client';
import { canDuplicateWorkflow } from '../model/duplicate/allowed';
import { WorkflowDuplicateDialog } from './workflow-duplicate-dialog';

/** Shared detail action; Build supplies its own dirty/save guard. */
export function WorkflowDuplicateAction({
  apiClient,
  userId,
  workspace,
  workflow,
  blocked = false,
  open,
  onOpenChange,
  triggerClassName,
  finalFocus,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  blocked?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerClassName?: string;
  finalFocus?: ComponentProps<typeof DialogContent>['finalFocus'];
}>) {
  const navigate = useNavigate();
  if (!canDuplicateWorkflow(workspace, workflow)) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={blocked}
        className={triggerClassName}
        title={
          blocked
            ? 'Save or resolve unfinished edits and conflicts before copying the saved draft.'
            : undefined
        }
        onClick={() => {
          onOpenChange(true);
        }}
      >
        Duplicate…
      </Button>
      {open ? (
        <WorkflowDuplicateDialog
          key={`${userId}:${workspace.id}:${workflow.id}`}
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          workflow={workflow}
          source={{ kind: 'draft' }}
          finalFocus={finalFocus}
          allowed={!blocked}
          onClose={() => {
            onOpenChange(false);
          }}
          onCreated={(workflowId) => {
            onOpenChange(false);
            void navigate({
              to: '/w/$workspaceId/workflows/$workflowId',
              params: { workspaceId: workspace.id, workflowId },
            });
          }}
        />
      ) : null}
    </>
  );
}
