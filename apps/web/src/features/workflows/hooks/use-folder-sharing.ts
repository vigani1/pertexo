import type { FolderSharing } from '@pertexo/contracts';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import { useSharingEditor } from '@/lib/resource-sharing/use-editor';
import {
  readFolderSharing,
  replaceFolderSharing,
} from '../data/organization/sharing.api';
import { workflowOrganizationKeys } from '../data/organization/queries';
export function useFolderSharingEditor(
  scope: WorkspaceApiScope,
  folderId: string | undefined,
  onSaved?: () => void,
) {
  return useSharingEditor<FolderSharing>({
    resourceId: folderId,
    queryKey: [
      'identity',
      scope.userId,
      'workspace',
      scope.workspaceId,
      'folder-sharing',
      folderId ?? '',
    ],
    invalidationKey: workflowOrganizationKeys.scope(
      scope.userId,
      scope.workspaceId,
    ),
    read: (signal) => readFolderSharing(scope, folderId ?? '', signal),
    replace: (snapshot, key) =>
      replaceFolderSharing(
        scope,
        snapshot.folderId,
        {
          mode: snapshot.mode,
          expectedFolderRevision: snapshot.revision,
          grants: snapshot.mode === 'workspace' ? [] : snapshot.grants,
        },
        key,
      ),
    onSaved,
  });
}
