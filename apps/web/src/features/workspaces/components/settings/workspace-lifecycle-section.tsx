import type {
  AccessibleWorkspace,
  WorkspaceLifecycleOperationResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import {
  GlassSection,
  GlassSectionContent,
  GlassSectionDescription,
  GlassSectionHeader,
  GlassSectionTitle,
} from '@/components/patterns/glass-section';
import type { ApiClient } from '@/lib/api/client';
import { useWorkspaceLifecycleCommand } from '../../mutations/use-workspace-lifecycle-command';
import { WorkspaceDeletionDialog } from './workspace-deletion-dialog';
import { WorkspaceLifecycleOperation } from './workspace-lifecycle-operation';
import { WorkspaceRestoreDialog } from './workspace-restore-dialog';

export function WorkspaceLifecycleSection({
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
  operation?: WorkspaceLifecycleOperationResponse;
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
  return (
    <GlassSection className="border-destructive/20">
      <GlassSectionHeader>
        <GlassSectionTitle>Workspace lifecycle</GlassSectionTitle>
        <GlassSectionDescription>
          Deletion and restoration are durable asynchronous operations. An
          accepted request does not mean the change has completed.
        </GlassSectionDescription>
      </GlassSectionHeader>
      <GlassSectionContent className="space-y-5">
        {operation === undefined && !operationLoading && !operationReadError ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {workspace.status === 'pending_deletion'
                ? 'This workspace is pending deletion. Restore it during the server-owned recovery window if it should be retained.'
                : 'Requesting deletion moves this workspace into a recoverable pending state before the server-managed purge.'}
            </p>
            {workspace.status === 'pending_deletion' ? (
              <WorkspaceRestoreDialog
                workspaceName={workspace.name}
                pending={command.pending}
                retryAvailable={command.retryAvailable}
                onDismissUncertain={command.dismissUncertain}
                onRestore={() => command.start({ command: 'restore' })}
                onRetry={command.retry}
                {...(command.error === undefined
                  ? {}
                  : { error: command.error })}
              />
            ) : (
              <WorkspaceDeletionDialog
                workspaceName={workspace.name}
                pending={command.pending}
                retryAvailable={command.retryAvailable}
                onDismissUncertain={command.dismissUncertain}
                onRequest={(reason) =>
                  command.start({ command: 'request-deletion', reason })
                }
                onRetry={command.retry}
                {...(command.error === undefined
                  ? {}
                  : { error: command.error })}
              />
            )}
          </div>
        ) : null}
        <WorkspaceLifecycleOperation
          {...(operation === undefined ? {} : { operation })}
          loading={operationLoading}
          readError={operationReadError}
          onRetryRead={onRetryOperationRead}
          onDismiss={onOperationDismissed}
        />
      </GlassSectionContent>
    </GlassSection>
  );
}
