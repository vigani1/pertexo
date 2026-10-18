import { lazy, Suspense, type ComponentProps } from 'react';
import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import type { DialogContent } from '@/components/ui/dialog';
import type { ApiClient } from '@/lib/api/client';

// Loaded on first open: the workflow bar is on every hub page and in its
// loading state, so a static import put the whole dialog in the first load.
const WorkflowExportDialog = lazy(() =>
  import('./workflow-export-dialog').then((module) => ({
    default: module.WorkflowExportDialog,
  })),
);

export function WorkflowExportAction({
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
