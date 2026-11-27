import type {
  AccessibleWorkspace,
  WorkspaceLifecycleChangeResponse,
} from '@pertexo/contracts';
import { useState } from 'react';
import { SettingRow } from '@/components/patterns/settings/row';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/patterns/notices/inline-notice';
import type { ApiClient } from '@/lib/api/client';
import { useWorkspaceLifecycleCommand } from '../../data/mutations/use-workspace-lifecycle-command';
import { WorkspaceDeletionDialog } from './workspace-deletion-dialog';
import { WorkspaceLifecycleDialog } from './workspace-lifecycle-dialog';
import { DATA_RETENTION_DAYS } from '@pertexo/workflow-model';
import { formatCount } from '@/lib/format/count';
type LifecycleChange = WorkspaceLifecycleChangeResponse['change'];
const COMPLETED: Readonly<Record<LifecycleChange, string>> = {
  deletion_requested: `The workspace is scheduled for deletion. Restore it within ${formatCount(DATA_RETENTION_DAYS.workspaceRecovery, 'day')} of the request to keep it.`,
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
      <SettingRow
        title="Restore workspace"
        description={`It’s scheduled for deletion within ${formatCount(DATA_RETENTION_DAYS.workspaceRecovery, 'day')} of the request. Restoring brings it back suspended, and an owner can then reactivate it; integrations stay off until they’re reconnected.`}
        action={
          <WorkspaceLifecycleDialog
            {...commandProps(command)}
            title={`Restore ${workspace.name}?`}
            description="This cancels the deletion. The workspace comes back suspended: people can sign in and look around, and an owner can then reactivate it. Triggers and integrations stay off until their connections are reconnected."
            action="Restore workspace"
            pendingLabel="Restoring…"
            onConfirm={() => command.start({ command: 'restore' })}
          />
        }
      />
    );
  return (
    <>
      {workspace.status === 'suspended' ? (
        <SettingRow
          title="Reactivate workspace"
          description="Lets people make changes and start runs again. Triggers and connections stay off until you turn them back on, and revoked API tokens stay revoked."
          action={
            <WorkspaceLifecycleDialog
              {...commandProps(reactivation)}
              title={`Reactivate ${workspace.name}?`}
              description="This lifts the suspension, so people can make changes and start runs again. Triggers and connections stay off until you turn them back on, and revoked API tokens stay revoked."
              action="Reactivate workspace"
              pendingLabel="Reactivating…"
              onConfirm={() => reactivation.start({ command: 'reactivate' })}
            />
          }
        />
      ) : null}
      <SettingRow
        title="Delete workspace"
        description={`Access and triggers stop straight away. You can restore it for ${formatCount(DATA_RETENTION_DAYS.workspaceRecovery, 'day')}; after that it’s gone for good.`}
        action={
          <WorkspaceDeletionDialog
            workspaceName={workspace.name}
            {...commandProps(command)}
            onRequest={(reason) =>
              command.start({ command: 'request-deletion', reason })
            }
          />
        }
      />
    </>
  );
}
function commandProps(
  command: ReturnType<typeof useWorkspaceLifecycleCommand>,
) {
  return {
    pending: command.pending,
    error: command.error,
  };
}
