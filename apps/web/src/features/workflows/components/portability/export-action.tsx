import type { WorkflowDraftActionProps } from '../workflow-draft-action-props';
import { Suspense } from 'react';
import { lazyPiece } from '@/components/patterns/app-update/lazy';
import { AppUpdatedDialog } from '@/components/patterns/app-update/notice';
import { Button } from '@/components/ui/button';

// Loaded on first open: the workflow bar is on every hub page and in its
// loading state, so a static import put the whole dialog in the first load.
const WorkflowExportDialog = lazyPiece(
  () =>
    import('./workflow-export-dialog').then(
      (module) => module.WorkflowExportDialog,
    ),
  AppUpdatedDialog,
);

export function WorkflowExportAction({
  workflow,
  blocked = false,
  open,
  onOpenChange,
  triggerClassName,
  finalFocus,
  scope,
}: WorkflowDraftActionProps) {
  const { apiClient, userId, workspace } = scope;

  if (!workspace.capabilities.includes('workflow:read')) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={blocked}
        className={triggerClassName}
        title={
          blocked
            ? 'Save or resolve unfinished edits and conflicts before exporting the saved draft.'
            : undefined
        }
        onClick={() => {
          onOpenChange(true);
        }}
      >
        Export…
      </Button>
      {open ? (
        <Suspense fallback={null}>
          <WorkflowExportDialog
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
          />
        </Suspense>
      ) : null}
    </>
  );
}
