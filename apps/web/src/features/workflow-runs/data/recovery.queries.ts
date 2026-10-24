import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getRunRecovery } from './recovery.api';
import { workflowRunKeys } from './history.queries';
export function recoveryQueryOptions(
  client: ApiClient,
  userId: string,
  workspaceId: string,
  runId: string,
) {
  return queryOptions({
    queryKey: [
      ...workflowRunKeys.detail(userId, workspaceId, runId),
      'recovery',
    ],
    queryFn: ({ signal }) => getRunRecovery(client, workspaceId, runId, signal),
    staleTime: 0,
    retry: false,
  });
}
