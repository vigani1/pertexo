import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import type { AccessibleWorkspace, WorkflowFolder } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { useNotifications } from '@/components/ui/use-notifications';
import { useWorkflowOrganizationCommand } from '../../../hooks/use-workflow-organization-command';
import { useAudienceMove } from '../../../hooks/use-audience-move';
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
  const [reviewed, setReviewed] = useState(action);
  const latest =
    reviewed.kind === 'create'
      ? undefined
      : folders.find((folder) => folder.id === reviewed.folder.id);
  const needsReview =
    reviewed.kind !== 'create' &&
    reviewed.kind !== 'share' &&
    (command.revisionConflict === true ||
      latest?.revision !== reviewed.folder.revision);
  const revisionReview = needsReview ? (
    <Notice
      tone="warning"
      action={
        <Button
          type="button"
          variant="outline"
          disabled={
            command.pending ||
            latest === undefined ||
            latest.revision === reviewed.folder.revision
          }
          onClick={() => {
            if (latest === undefined) return;
            setReviewed({ ...reviewed, folder: latest });
            command.reset();
          }}
        >
          Keep edits and use latest revision
        </Button>
      }
    >
      This folder changed. Current folder: {latest?.name ?? 'unavailable'}. Your
      edits are kept.
    </Notice>
  ) : undefined;
  const guardedCommand = { ...command, revisionConflict: needsReview };
  const scope = { workspaceId: workspace.id, revisionReview };
  switch (reviewed.kind) {
    case 'create':
    case 'rename':
      return (
        <FolderNameDialog
          {...scope}
          target={reviewed}
          command={guardedCommand}
          onClose={onClose}
        />
      );
    case 'move':
      return (
        <FolderMoveDialog
          {...scope}
          folder={reviewed.folder}
          folders={folders}
          command={guardedCommand}
          audience={audience}
          onClose={onClose}
        />
      );
    case 'delete':
      return (
        <FolderDeleteDialog
          {...scope}
          folder={reviewed.folder}
          command={guardedCommand}
          onClose={onClose}
        />
      );
    case 'share':
      return (
        <FolderShareDialog
          scope={{ apiClient, userId, workspaceId: workspace.id }}
          folder={reviewed.folder}
          folders={folders}
          onClose={onClose}
        />
      );
  }
}
