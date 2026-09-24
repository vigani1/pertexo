import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import {
  appendFailureNotificationDestinationVersion,
  createFailureNotificationDestination,
  setFailureNotificationDestinationStatus,
} from './failure-notifications.api';
import { failureNotificationDestinationKeys } from './failure-notifications.queries';

export type DestinationMutationScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>;

/** Create and edit share one key so the page can tell a save is in flight. */
export function destinationEditMutationKey(scope: DestinationMutationScope) {
  return [
    'failure-notification-destinations',
    scope.userId,
    scope.workspaceId,
    'edit',
  ] as const;
}

function useDestinationMutationInvalidation(scope: DestinationMutationScope) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: failureNotificationDestinationKeys.scope(
        scope.userId,
        scope.workspaceId,
      ),
    });
}

export function useCreateFailureNotificationDestinationMutation(
  scope: DestinationMutationScope,
) {
  const invalidate = useDestinationMutationInvalidation(scope);
  return useMutation({
    mutationKey: destinationEditMutationKey(scope),
    mutationFn: (
      command: Parameters<typeof createFailureNotificationDestination>[2],
    ) =>
      createFailureNotificationDestination(
        scope.apiClient,
        scope.workspaceId,
        command,
      ),
    onSuccess: invalidate,
  });
}

export function useAppendFailureNotificationDestinationVersionMutation(
  scope: DestinationMutationScope,
) {
  const invalidate = useDestinationMutationInvalidation(scope);
  return useMutation({
    mutationKey: destinationEditMutationKey(scope),
    mutationFn: (
      command: Parameters<
        typeof appendFailureNotificationDestinationVersion
      >[2],
    ) =>
      appendFailureNotificationDestinationVersion(
        scope.apiClient,
        scope.workspaceId,
        command,
      ),
    onSuccess: invalidate,
  });
}

export function useSetFailureNotificationDestinationStatusMutation(
  scope: DestinationMutationScope,
) {
  const invalidate = useDestinationMutationInvalidation(scope);
  return useMutation({
    mutationFn: (
      command: Parameters<typeof setFailureNotificationDestinationStatus>[2],
    ) =>
      setFailureNotificationDestinationStatus(
        scope.apiClient,
        scope.workspaceId,
        command,
      ),
    onSuccess: invalidate,
  });
}
