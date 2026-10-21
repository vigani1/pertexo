import type { ConnectionSharing } from '@pertexo/contracts';
import { useSharingEditor } from '@/lib/resource-sharing/use-editor';
import type { ConnectionMutationScope } from '../data/connections.mutations';
import { connectionKeys } from '../data/connections.queries';
import {
  readConnectionSharing,
  replaceConnectionSharing,
} from '../data/sharing.api';
export function useConnectionSharingEditor(
  scope: ConnectionMutationScope,
  connectionId: string | undefined,
) {
  return useSharingEditor<ConnectionSharing>({
    resourceId: connectionId,
    queryKey: [
      ...connectionKeys.scope(scope.userId, scope.workspaceId),
      'sharing',
      connectionId ?? '',
    ],
    invalidationKey: connectionKeys.scope(scope.userId, scope.workspaceId),
    read: (signal) => readConnectionSharing(scope, connectionId ?? '', signal),
    replace: (snapshot, key) =>
      replaceConnectionSharing(
        scope,
        snapshot.connectionId,
        {
          mode: snapshot.mode,
          expectedSharingRevision: snapshot.revision,
          userIds:
            snapshot.mode === 'workspace'
              ? []
              : snapshot.members.map((member) => member.userId),
        },
        key,
      ),
  });
}
