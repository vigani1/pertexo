import { useQueries } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/error';
import { getWorkflowOrganizationProjection } from '../../data/organization/api';
import { workflowOrganizationKeys } from '../../data/organization/queries';

/** Presentation-only labels for explicit assignments, never projection authority. */
export function useOrganizationWorkflowNames({
  apiClient,
  userId,
  workspaceId,
  workflowIds,
  denied,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowIds: readonly string[];
  denied: boolean;
}>) {
  const ids = [...new Set(workflowIds)].slice(0, 50);
  const reads = useQueries({
    queries: ids.map((workflowId) => ({
      queryKey: [
        ...workflowOrganizationKeys.scope(userId, workspaceId),
        'labels',
        workflowId,
      ],
      enabled: !denied,
      retry: false,
      staleTime: 0,
      queryFn: async ({
        signal,
      }: {
        signal: AbortSignal;
      }): Promise<string | null> => {
        try {
          const projection = await getWorkflowOrganizationProjection({
            api: apiClient,
            workspaceId,
            workflowId,
            input: { include: 'organization' },
            signal,
          });
          return projection.workflow.name;
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }
      },
    })),
  });
  return new Map(
    ids.flatMap((id, index) => {
      const read = reads[index];
      const name = read?.data;
      const hasCurrentName =
        !denied &&
        read?.isSuccess &&
        read.isFetchedAfterMount &&
        typeof name === 'string';
      return hasCurrentName ? [[id, name] as const] : [];
    }),
  );
}
