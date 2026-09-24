import type {
  AccessibleWorkspace,
  WorkspaceLifecycleOperationResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { ApiClient } from '@/lib/api/client';
import { useWorkspaceLifecycleCommand } from '../../mutations/use-workspace-lifecycle-command';
import { WorkspaceDeletionDialog } from './workspace-deletion-dialog';
import { WorkspaceLifecycleOperation } from './workspace-lifecycle-operation';
import { WorkspaceRestoreDialog } from './workspace-restore-dialog';

/** Delete or restore, fenced off from everything else on the page. */
export function WorkspaceDangerZone({
  apiClient,
  workspace,
  operation,
  operationLoading,
  operationReadError,
  onOperationAccepted,
  onOperationDismissed,
  onRetryOperationRead,
}: Readonly<{
  apiClient: ApiClient;
  workspace: AccessibleWorkspace;
  operation: WorkspaceLifecycleOperationResponse | undefined;
  operationLoading: boolean;
  operationReadError: boolean;
  onOperationAccepted: (operationId: string) => void;
  onOperationDismissed: () => void;
  onRetryOperationRead: () => void;
}>) {
  const command = useWorkspaceLifecycleCommand({
    apiClient,
    workspaceId: workspace.id,
    onAccepted: onOperationAccepted,
  });
  const pendingDeletion = workspace.status === 'pending_deletion';
  const showAction =
    operation === undefined && !operationLoading && !operationReadError;

  return (
    <section
      aria-labelledby="danger-zone-title"
      className="flex flex-col gap-4 rounded-xl border border-destructive/25 p-5"
    >
      <h2 id="danger-zone-title" className="text-lg font-semibold">
        Danger zone
      </h2>
      {showAction ? (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="max-w-xl">
            <p className="text-sm font-semibold">
              {pendingDeletion ? 'Restore workspace' : 'Delete workspace'}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {pendingDeletion
                ? 'It’s scheduled for deletion within 30 days of the request. Restoring brings it back suspended; integrations stay off until they’re reconnected.'
                : 'Access and triggers stop straight away. You can restore it for 30 days; after that it’s gone for good.'}
            </p>
          </div>
          {pendingDeletion ? (
            <WorkspaceRestoreDialog
              workspaceName={workspace.name}
              pending={command.pending}
              retryAvailable={command.retryAvailable}
              error={command.error}
              onDismissUncertain={command.dismissUncertain}
              onRestore={() => command.start({ command: 'restore' })}
              onRetry={command.retry}
            />
          ) : (
            <WorkspaceDeletionDialog
              workspaceName={workspace.name}
              pending={command.pending}
              retryAvailable={command.retryAvailable}
              error={command.error}
              onDismissUncertain={command.dismissUncertain}
              onRequest={(reason) =>
                command.start({ command: 'request-deletion', reason })
              }
              onRetry={command.retry}
            />
          )}
        </div>
      ) : null}
      <WorkspaceLifecycleOperation
        operation={operation}
        loading={operationLoading}
        readError={operationReadError}
        onRetryRead={onRetryOperationRead}
        onDismiss={onOperationDismissed}
      />
    </section>
  );
}
