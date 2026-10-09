import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { markInboxRead, markInboxThreadRead } from './inbox.api';
import { inboxKeys } from './inbox.queries';

export type InboxScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>;

/** Reads settle on the server first; then every inbox view refetches. */
function useInboxInvalidation(scope: InboxScope) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: inboxKeys.scope(scope.userId, scope.workspaceId),
    });
}

export function useMarkThreadReadMutation(scope: InboxScope) {
  const invalidate = useInboxInvalidation(scope);
  return useMutation({
    mutationFn: (thread: Readonly<{ workflowId: string; revision: string }>) =>
      markInboxThreadRead(
        scope.apiClient,
        scope.workspaceId,
        thread.workflowId,
        thread.revision,
      ),
    onSettled: invalidate,
  });
}

export function useMarkAllReadMutation(scope: InboxScope) {
  const invalidate = useInboxInvalidation(scope);
  return useMutation({
    mutationFn: (revision: string) =>
      markInboxRead(scope.apiClient, scope.workspaceId, revision),
    onSettled: invalidate,
  });
}
