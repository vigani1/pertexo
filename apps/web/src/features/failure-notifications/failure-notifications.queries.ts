import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getFailureNotificationDestinations } from './failure-notifications.api';

export const failureNotificationDestinationKeys = {
  scope: (userId: string, workspaceId: string) =>
    [
      'identity',
      userId,
      'workspace',
      workspaceId,
      'failure-notification-destinations',
    ] as const,
};

export function failureNotificationDestinationsQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: failureNotificationDestinationKeys.scope(userId, workspaceId),
    queryFn: ({ signal }) =>
      getFailureNotificationDestinations(apiClient, workspaceId, signal),
  });
}
