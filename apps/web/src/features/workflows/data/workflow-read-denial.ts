import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { readAccessLost } from '@/lib/api/error-copy';
import { workflowKeys, workflowSummaryQueryOptions } from './workflows.queries';

/**
 * Whether this person lost read access to the workflow. Only the workflow's
 * own read proves it; a refused command re-reads it. Once lost, every
 * private read about the workflow in this workspace loses its snapshot.
 */
export function useWorkflowReadDenial({
  apiClient,
  userId,
  workspaceId,
  workflowId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
}>): boolean {
  const cache = useQueryClient();
  const own = useQuery(
    workflowSummaryQueryOptions(apiClient, userId, workspaceId, workflowId),
  );
  const denied = readAccessLost(own);
  useEffect(
    () =>
      cache.getMutationCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'error') return;
        const cause: unknown = event.mutation.state.error;
        if (isApiError(cause) && [403, 404].includes(cause.status ?? 0)) {
          void cache.invalidateQueries({
            queryKey: workflowKeys.detail(userId, workspaceId, workflowId),
            exact: true,
          });
        }
      }),
    [cache, userId, workspaceId, workflowId],
  );
  useEffect(() => {
    if (!denied) return;
    const ownQuery = cache.getQueryCache().find({
      queryKey: workflowKeys.detail(userId, workspaceId, workflowId),
      exact: true,
    });
    const predicate = (query: { queryKey: readonly unknown[] }) => {
      const key = query.queryKey;
      const isWorkflowPrivateRead =
        key[0] === 'identity' &&
        key[1] === userId &&
        key[2] === 'workspace' &&
        key[3] === workspaceId &&
        (key.slice(4).includes(workflowId) ||
          [
            'workflows',
            'workflow-organization',
            'runs',
            'inbox',
            'pending-tasks',
            'trends',
          ].includes(String(key[4])));
      return isWorkflowPrivateRead;
    };
    // Preserve the rejecting read's error while canceled siblings lose their snapshots.
    void cache
      .cancelQueries({
        predicate: (query) => predicate(query) && query !== ownQuery,
      })
      .then(() => {
        for (const query of cache.getQueryCache().findAll({ predicate }))
          query.setState({ data: undefined, dataUpdatedAt: 0 });
        void cache.invalidateQueries({
          predicate: (query) => predicate(query) && query !== ownQuery,
        });
      });
  }, [cache, denied, userId, workspaceId, workflowId]);
  return denied;
}
