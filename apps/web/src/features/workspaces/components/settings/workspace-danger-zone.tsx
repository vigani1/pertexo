import type {
  AccessibleWorkspace,
  WorkspaceLifecycleChangeResponse,
} from '@pertexo/contracts';
import { useState, type ReactNode } from 'react';
import { SettingsSection } from '@/components/patterns/settings/section';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import type { ApiClient } from '@/lib/api/client';
import { useWorkspaceLifecycleCommand } from '../../data/mutations/lifecycle/use-command';
import { WorkspaceDeletionDialog } from './workspace-deletion-dialog';
import { WorkspaceLifecycleDialog } from './workspace-lifecycle-dialog';

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
  reactivated:
    'The workspace is active again. Triggers and connections stay off until you turn them back on, and revoked API tokens stay revoked.',
};

const COMPLETED_LABEL: Readonly<Record<LifecycleChange, string>> = {
  deletion_requested: 'Deletion request',
  deletion_restored: 'Restore request',
  reactivated: 'Reactivation',
};

/** Delete, restore or reactivate the workspace; what the request did stays until dismissed. */
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
  const target = { apiClient, workspaceId: workspace.id, userId };
  const onChanged = (change: LifecycleChange) => {
    setCompleted(change);
    return onCompleted();
  };
  const command = useWorkspaceLifecycleCommand({
    ...target,
    onCompleted: onChanged,
  });
  // Separate state, so a failed reactivation doesn't show in the deletion dialog.
  const reactivation = useWorkspaceLifecycleCommand({
    ...target,
    onCompleted: onChanged,
  });

  if (completed !== undefined)
    return (
      <Notice
        tone="success"
        aria-label={COMPLETED_LABEL[completed]}
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
  if (workspace.status === 'pending_deletion')
    return (
      <DangerAction
        title="Restore workspace"
        description="It’s scheduled for deletion within 30 days of the request. Restoring brings it back suspended, and an owner can then reactivate it; integrations stay off until they’re reconnected."
      >
        <WorkspaceLifecycleDialog
          {...commandProps(command)}
          title={`Restore ${workspace.name}?`}
          description="This cancels the deletion. The workspace comes back suspended: people can sign in and look around, and an owner can then reactivate it. Triggers and integrations stay off until their connections are reconnected."
          action="Restore workspace"
          pendingLabel="Restoring…"
          onConfirm={() => command.start({ command: 'restore' })}
        />
      </DangerAction>
    );
  return (
    <>
      {workspace.status === 'suspended' ? (
        <DangerAction
          title="Reactivate workspace"
          description="Lets people make changes and start runs again. Triggers and connections stay off until you turn them back on, and revoked API tokens stay revoked."
        >
          <WorkspaceLifecycleDialog
            {...commandProps(reactivation)}
            title={`Reactivate ${workspace.name}?`}
            description="This lifts the suspension, so people can make changes and start runs again. Triggers and connections stay off until you turn them back on, and revoked API tokens stay revoked."
            action="Reactivate workspace"
            pendingLabel="Reactivating…"
            onConfirm={() => reactivation.start({ command: 'reactivate' })}
          />
        </DangerAction>
      ) : null}
      <DangerAction
        title="Delete workspace"
        description="Access and triggers stop straight away. You can restore it for 30 days; after that it’s gone for good."
      >
        <WorkspaceDeletionDialog
          workspaceName={workspace.name}
          {...commandProps(command)}
          onRequest={(reason) =>
            command.start({ command: 'request-deletion', reason })
          }
        />
      </DangerAction>
    </>
  );
}

function commandProps(
  command: ReturnType<typeof useWorkspaceLifecycleCommand>,
) {
  return {
    pending: command.pending,
    retryAvailable: command.retryAvailable,
    error: command.error,
    onDismissUncertain: command.dismissUncertain,
    onRetry: command.retry,
  };
}
