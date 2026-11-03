import { queryOptions, skipToken } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { collectPages } from '@/lib/api/pagination';
import { getWorkflowsPage } from '../workflows.api';

export function pinnedParentsQueryOptions(
  input: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspaceId: string;
    workflowId: string;
    enabled: boolean;
  }>,
) {
  return queryOptions({
    queryKey: [
      'identity',
      input.userId,
      'workspace',
      input.workspaceId,
      'workflow-pins',
      input.workflowId,
    ] as const,
    queryFn: input.enabled
      ? ({ signal }) =>
          collectPages(
            (after) =>
              getWorkflowsPage(input.apiClient, input.workspaceId, {
                pinsWorkflowId: input.workflowId,
                ...(after === undefined ? {} : { after }),
                signal,
              }),
            { read: 'Published parent discovery', signal },
          )
      : skipToken,
    staleTime: 0,
  });
}
