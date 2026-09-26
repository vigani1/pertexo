import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { workspaceRenameRequestSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { InlineRename } from '@/components/patterns/inline-rename';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { useWorkspaceRename } from '../../mutations/use-workspace-rename';

function nameError(name: string): string | undefined {
  return workspaceRenameRequestSchema.shape.name.safeParse(name).success
    ? undefined
    : 'Name the workspace in 1 to 128 characters.';
}

/**
 * The workspace name, renamed in place by people who manage the workspace.
 * Save sends the revision the edit started from; a rename made meanwhile is
 * shown so people choose between their name and the newer one.
 */
export function WorkspaceNameField({
  apiClient,
  userId,
  workspace,
  onWorkspaceChanged,
  onAccessLost,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  onWorkspaceChanged: () => void;
  onAccessLost: () => void;
}>) {
  const notifications = useNotifications();
  const command = useWorkspaceRename({
    apiClient,
    userId,
    workspaceId: workspace.id,
    onChanged: (renamed) => {
      notifications.success({ title: `Renamed to ${renamed}` });
      onWorkspaceChanged();
    },
    onReloaded: onWorkspaceChanged,
    onAccessLost,
  });
  const display = (
    <span className="min-w-0 break-all text-sm font-semibold">
      {workspace.name}
    </span>
  );
  if (
    workspace.status !== 'active' ||
    !workspace.capabilities.includes('workspace:manage')
  )
    return display;

  return (
    <InlineRename
      name={workspace.name}
      revision={workspace.revision}
      subject="workspace"
      label="Workspace name"
      // The row already says Name; the field keeps it for readers.
      className="[&_[data-slot=field-label]]:sr-only"
      validate={nameError}
      command={command}
      onSave={(name, expectedRevision) =>
        command.start({
          body: workspaceRenameRequestSchema.parse({ name, expectedRevision }),
          idempotencyKey: crypto.randomUUID(),
        })
      }
    >
      {display}
    </InlineRename>
  );
}
