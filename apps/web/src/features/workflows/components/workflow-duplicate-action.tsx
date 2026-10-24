import { Suspense, type ComponentProps } from 'react';
import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { useNavigate } from '@tanstack/react-router';
import { lazyPiece } from '@/components/patterns/app-update/lazy';
import { AppUpdatedDialog } from '@/components/patterns/app-update/notice';
import { Button } from '@/components/ui/button';
import type { DialogContent } from '@/components/ui/dialog';
import type { ApiClient } from '@/lib/api/client';
import { canDuplicateWorkflow } from '../model/duplicate/allowed';

// Loaded on first open, like the export dialog beside it in the workflow bar.
const WorkflowDuplicateDialog = lazyPiece(
  () =>
    import('./workflow-duplicate-dialog').then(
      (module) => module.WorkflowDuplicateDialog,
    ),
  AppUpdatedDialog,
);

/** Shared detail action; Build supplies its own dirty/save guard. */
export function WorkflowDuplicateAction({
  workflow,
  blocked = false,
  open,
  onOpenChange,
  triggerClassName,
  finalFocus,
  scope,
}: Readonly<{
  workflow: WorkflowSummary;
  blocked?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerClassName?: string;
  finalFocus?: ComponentProps<typeof DialogContent>['finalFocus'];
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: AccessibleWorkspace;
  }>;
}>) {
  const { apiClient, userId, workspace } = scope;

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
        <Suspense fallback={null}>
          <WorkflowDuplicateDialog
            key={`${userId}:${workspace.id}:${workflow.id}`}
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
            scope={{
              apiClient,
              userId,
              workspace,
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}
