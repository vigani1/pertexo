import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AccessibleWorkspace, WorkflowFolder } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { useNotifications } from '@/components/ui/use-notifications';
import { useWorkflowOrganizationCommand } from '../../../hooks/use-workflow-organization-command';
import { useAudienceMove } from '../../../hooks/use-audience-move';
import { workflowOrganizationKeys } from '../../../data/organization/queries';
import type { FolderAction } from './shelf';
import {
  FolderDeleteDialog,
  FolderMoveDialog,
  FolderNameDialog,
} from './dialogs';
import { FolderShareDialog } from './share-dialog';

const DONE: Readonly<Record<FolderAction['kind'], string>> = {
  create: 'Folder created',
  rename: 'Folder renamed',
  move: 'Folder moved',
  share: 'Sharing saved',
  delete: 'Folder deleted',
};

/**
 * One folder dialog at a time. Mount it per action (keyed), so each dialog
 * owns a fresh command and an uncertain one can only be retried exactly.
 */
export function FolderActionDialog({
  apiClient,
  userId,
  workspace,
  folders,
  action,
  onClose,
  onDone,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  folders: readonly WorkflowFolder[];
  action: FolderAction;
  onClose: () => void;
  /** After a confirmed change, e.g. leaving a folder that was just deleted. */
  onDone: (action: FolderAction) => void;
}>) {
  const command = useWorkflowOrganizationCommand({
    apiClient,
    userId,
    workspace,
    requiredRole: 'admin',
  });
  const audience = useAudienceMove(apiClient, workspace.id, (attempt) =>
    command.start(attempt),
  );
  const notifications = useNotifications();
  const succeeded =
    command.result !== undefined &&
    !command.pending &&
    !command.retryAvailable &&
    !command.denied;
  // Once per confirmed result: the notifier changes as toasts come and go.
  const announced = useRef(command.result);
  useEffect(() => {
    if (!succeeded || announced.current === command.result) return;
    announced.current = command.result;
    notifications.success({ title: DONE[action.kind] });
    onDone(action);
  }, [succeeded, notifications, onDone, action, command.result]);
  // A refused change usually means the folder changed; load the current one.
  const refused = command.error !== undefined && !command.retryAvailable;
  const cache = useQueryClient();
  useEffect(() => {
    if (refused)
      void cache.invalidateQueries({
        queryKey: workflowOrganizationKeys.folders(userId, workspace.id),
      });
  }, [refused, cache, userId, workspace.id]);
  const scope = { workspaceId: workspace.id };
  switch (action.kind) {
    case 'create':
    case 'rename':
      return (
        <FolderNameDialog
          {...scope}
          target={action}
          command={command}
          onClose={onClose}
        />
      );
    case 'move':
      return (
        <FolderMoveDialog
          {...scope}
          folder={action.folder}
          folders={folders}
          command={command}
          audience={audience}
          onClose={onClose}
        />
      );
    case 'delete':
      return (
        <FolderDeleteDialog
          {...scope}
          folder={action.folder}
          command={command}
          onClose={onClose}
        />
      );
    case 'share':
      return (
        <FolderShareDialog
          scope={{ apiClient, userId, workspaceId: workspace.id }}
          folder={action.folder}
          folders={folders}
          onClose={onClose}
        />
      );
  }
}
