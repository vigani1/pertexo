import { useQueries } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/api-error';
import { getWorkflowOrganizationProjection } from '../../organization.api';
import { workflowOrganizationKeys } from '../../organization.queries';

/** Presentation-only labels for explicit assignments, never projection authority. */
export function useOrganizationWorkflowNames(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowIds: readonly string[],
  denied: boolean,
) {
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
          const projection = await getWorkflowOrganizationProjection(
            apiClient,
            workspaceId,
            workflowId,
            { include: 'organization' },
            signal,
          );
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
      return !denied &&
        read?.isSuccess &&
        read.isFetchedAfterMount &&
        typeof read.data === 'string'
        ? [[id, read.data] as const]
        : [];
    }),
  );
}
