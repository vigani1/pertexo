import type { FailureNotificationDestinationResponse } from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import type { DestinationMutationScope } from '../data/failure-notifications.mutations';
import { failureNotificationDestinationsQueryOptions } from '../data/failure-notifications.queries';

/** Existing connection destinations cannot switch methods; they need no availability read. */
export function useSystemMailAvailability(
  scope: DestinationMutationScope,
  destination: FailureNotificationDestinationResponse | undefined,
) {
  const query = useQuery({
    ...failureNotificationDestinationsQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspaceId,
    ),
    enabled: destination === undefined || destination.kind === 'system_mail',
  });
  return (
    query.data?.systemMail ?? {
      available: false as const,
      reason: query.isPending
        ? 'Checking this server’s mail configuration…'
        : 'This server has no system mail configured.',
    }
  );
}
