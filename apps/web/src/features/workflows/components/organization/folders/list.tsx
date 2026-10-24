import { isAdministrativeRole } from '@pertexo/workflow-model';
import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { FolderShelf, type FolderAction } from './shelf';
import { FolderActionDialog } from './actions';
import { workflowFoldersQueryOptions } from '../../../data/organization/queries';
import {
  isOrganizationReadDenied,
  useOrganizationReadLifetime,
} from '../../../hooks/use-organization-read-lifetime';

/**
 * The folders above the list and the dialog for whichever folder action is
 * open. Folders are managed by owners and admins; everyone can open them.
 */
export function WorkflowFolders({
  apiClient,
  userId,
  workspace,
  folderId,
  onOpen,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  folderId: string | undefined;
  onOpen: (folderId: string | null) => void;
}>) {
  // A denied organization read anywhere retires the folder names too.
  const lifetime = useOrganizationReadLifetime(userId, workspace.id);
  const folders = useQuery({
    ...workflowFoldersQueryOptions(apiClient, userId, workspace.id),
    enabled: lifetime.error === undefined,
  });
  const [action, setAction] = useState<FolderAction>();
  const items = folders.data?.items ?? [];
  const canManage =
    workspace.status === 'active' && isAdministrativeRole(workspace.role);
  const close = useCallback(() => {
    setAction(undefined);
  }, []);
  const done = useCallback(
    (finished: FolderAction) => {
      setAction(undefined);
      // Leaving a folder that no longer exists.
      if (finished.kind === 'delete' && finished.folder.id === folderId)
        onOpen(finished.folder.parentId);
    },
    [folderId, onOpen],
  );
  if (
    folders.data === undefined ||
    lifetime.error !== undefined ||
    isOrganizationReadDenied(folders.error)
  )
    return null;
  return (
    <>
      <FolderShelf
        folders={items}
        currentFolderId={folderId === 'root' ? undefined : folderId}
        canManage={canManage}
        onOpen={onOpen}
        onAction={setAction}
      />
      {action === undefined ? null : (
        <FolderActionDialog
          key={`${action.kind}:${action.kind === 'create' ? (action.parent?.id ?? 'top') : action.folder.id}`}
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          folders={items}
          action={action}
          onClose={close}
          onDone={done}
        />
      )}
    </>
  );
}
