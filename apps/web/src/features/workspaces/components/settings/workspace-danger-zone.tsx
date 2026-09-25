import type {
  AccessibleWorkspace,
  WorkspaceLifecycleOperationResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { ReactNode } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { useWorkspaceLifecycleCommand } from '../../mutations/use-workspace-lifecycle-command';
import { WorkspaceDeletionDialog } from './workspace-deletion-dialog';
import { WorkspaceLifecycleOperation } from './workspace-lifecycle-operation';
import { WorkspaceRestoreDialog } from './workspace-restore-dialog';

/** Irreversible or hard-to-undo actions, fenced off from the rest. */
export function DangerZone({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <section
      aria-labelledby="danger-zone-title"
      className="flex flex-col gap-6 rounded-xl border border-destructive/25 p-5"
    >
      <h2 id="danger-zone-title" className="text-lg font-semibold">
        Danger zone
      </h2>
      {children}
    </section>
  );
}

/**
 * One action in the danger zone: what it does, with its button beside it on
 * a wide screen, so every row lines up however long its sentence is.
 */
export function DangerAction({
  title,
  description,
  children,
}: Readonly<{ title: string; description: string; children: ReactNode }>) {
  return (
    <div className="grid items-center gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="max-w-xl">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex">{children}</div>
    </div>
  );
}

/** Delete or restore the workspace, with its lifecycle operation. */
export function WorkspaceLifecycleControls({
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
    <div className="flex flex-col gap-4">
      {showAction ? (
        <DangerAction
          title={pendingDeletion ? 'Restore workspace' : 'Delete workspace'}
          description={
            pendingDeletion
              ? 'It’s scheduled for deletion within 30 days of the request. Restoring brings it back suspended; integrations stay off until they’re reconnected.'
              : 'Access and triggers stop straight away. You can restore it for 30 days; after that it’s gone for good.'
          }
        >
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
        </DangerAction>
      ) : null}
      <WorkspaceLifecycleOperation
        operation={operation}
        loading={operationLoading}
        readError={operationReadError}
        onRetryRead={onRetryOperationRead}
        onDismiss={onOperationDismissed}
      />
    </div>
  );
}
