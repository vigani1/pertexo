import type {
  AccessibleWorkspace,
  WorkspaceLifecycleChangeResponse,
} from '@pertexo/contracts';
import { useState, type ReactNode } from 'react';
import { SettingsSection } from '@/components/patterns/settings-section';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import type { ApiClient } from '@/lib/api/client';
import { useWorkspaceLifecycleCommand } from '../../data/mutations/lifecycle/use-command';
import { WorkspaceDeletionDialog } from './workspace-deletion-dialog';
import { WorkspaceRestoreDialog } from './workspace-restore-dialog';

type LifecycleChange = WorkspaceLifecycleChangeResponse['change'];

/** Irreversible or hard-to-undo actions, fenced off from the rest. */
export function DangerZone({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <SettingsSection
      title="Danger zone"
      description="Changes to the whole workspace that are hard to undo. Each one asks you to confirm first."
    >
      <div className="flex flex-col gap-6 rounded-xl border border-destructive/25 p-5">
        {children}
      </div>
    </SettingsSection>
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

const COMPLETED: Readonly<Record<LifecycleChange, string>> = {
  deletion_requested:
    'The workspace is scheduled for deletion. Restore it within 30 days of the request to keep it.',
  deletion_restored:
    'The workspace is back, suspended. Triggers and integrations stay off until you reconnect them.',
};

/** Delete or restore the workspace; what the request did stays until dismissed. */
export function WorkspaceLifecycleControls({
  apiClient,
  workspace,
  userId,
  onCompleted,
}: Readonly<{
  apiClient: ApiClient;
  workspace: AccessibleWorkspace;
  userId: string;
  onCompleted: () => void | Promise<void>;
}>) {
  const [completed, setCompleted] = useState<LifecycleChange>();
  const command = useWorkspaceLifecycleCommand({
    apiClient,
    workspaceId: workspace.id,
    userId,
    onCompleted: (change) => {
      setCompleted(change);
      return onCompleted();
    },
  });
  const pendingDeletion = workspace.status === 'pending_deletion';

  if (completed !== undefined)
    return (
      <Notice
        tone="success"
        aria-label={
          completed === 'deletion_requested'
            ? 'Deletion request'
            : 'Restore request'
        }
        action={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              setCompleted(undefined);
            }}
          >
            Dismiss
          </Button>
        }
      >
        {COMPLETED[completed]}
      </Notice>
    );
  return (
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
  );
}
