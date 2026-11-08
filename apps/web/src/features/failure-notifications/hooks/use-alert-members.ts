import { useInfiniteQuery } from '@tanstack/react-query';
import { workspaceMembersInfiniteQueryOptions } from '@/features/workspaces/workspaces-queries.public';
import type { DestinationMutationScope } from '../data/failure-notifications.mutations';

export function useAlertMembers(
  scope: DestinationMutationScope,
  enabled: boolean,
) {
  const query = useInfiniteQuery({
    ...workspaceMembersInfiniteQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspaceId,
    ),
    enabled,
  });
  const members =
    query.data?.pages
      .flatMap((page) => page.items)
      .filter((member) => member.membershipStatus === 'active') ?? [];
  return { query, members };
}
